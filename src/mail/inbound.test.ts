import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as audit from "../audit/audit.js";
import { auditEvents, botDefinitions, chatAssignments, chats, mailboxes } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { upsertTenant } from "../org/org.js";
import { encrypt } from "../secrets/cipher.js";
import { mountMailInbound } from "./inbound.js";

const auditBroken = { chat: "" };
vi.mock("../audit/audit.js", async (orig) => {
  const real = await orig<typeof import("../audit/audit.js")>();
  return { ...real, beginAction: (db: never, i: { chatId: string }) => (i.chatId === auditBroken.chat ? Promise.reject(new Error("audit down")) : real.beginAction(db, i as never)) };
});
void audit;

const secretsKey = Buffer.alloc(32, 7);
const SECRET = "amwh_test";
const NOW = new Date("2026-10-31T10:00:00Z");
let server: Server | undefined;
afterEach(() => void server?.close());

async function setup() {
  const db = await testDb();
  await upsertTenant(db, { id: "t1" });
  await db.insert(botDefinitions).values({ id: "d1", tenantId: "t1", name: "bot", label: "bot", persona: "", model: "m", webSearch: false, computer: false, mcpServers: [] });
  for (const id of ["c1", "c2"]) {
    await db.insert(chats).values({ id, tenantId: "t1", conversationType: "personal" });
    await db.insert(chatAssignments).values({ chatId: id, definitionId: "d1" });
  }
  await db.insert(mailboxes).values({ definitionId: "d1", tenantId: "t1", agent: "bb2-d1", address: "ada@mail.test", status: "active", webhookSecretCipher: encrypt(secretsKey, SECRET) });
  const sent: [string, string][] = [];
  // json first, like startServer, so the test proves the route still sees the raw bytes
  const app = express();
  app.use(express.json());
  mountMailInbound(app, { db, secretsKey, send: async (c, m) => void sent.push([c, m]), now: () => NOW });
  server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const post = async (event: object, o: { secret?: string; ts?: string } = {}) => {
    const body = JSON.stringify(event);
    const ts = o.ts ?? String(Math.floor(NOW.getTime() / 1000));
    const sig = createHmac("sha256", o.secret ?? SECRET).update(`${ts}.${body}`).digest("hex");
    const r = await fetch(`http://127.0.0.1:${port}/mail/inbound`, { method: "POST", headers: { "content-type": "application/json", "x-agentmail-timestamp": ts, "x-agentmail-signature": sig }, body });
    // the notices go out after the response
    await new Promise((r) => setTimeout(r, 50));
    return r.status;
  };
  return { db, sent, post };
}

const event = (o: { id?: string; from?: string; subject?: string; agent?: string } = {}) => ({
  id: o.id ?? "ev1", type: "message.received", agent: o.agent ?? "bb2-d1", inbox: "i1",
  message: { id: "m1", from_address: o.from ?? "bob@example.com", subject: o.subject ?? "Invoice\nattached", body: "SECRET BODY TEXT" },
});

describe("mail inbound", () => {
  it("tells every assigned chat, with sender and subject but never the body", async () => {
    const { sent, post, db } = await setup();
    expect(await post(event())).toBe(200);
    expect(sent.map((s) => s[0]).sort()).toEqual(["c1", "c2"]);
    expect(sent[0]![1]).toBe("New email to ada@mail.test from bob\\@example.com: Invoice attached");
    expect(sent.join()).not.toContain("SECRET BODY");
    const rows = await db.select().from(auditEvents);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.summary).toBe("Email from bob@example.com: Invoice attached");
  });

  it("rejects a bad signature and posts nothing", async () => {
    const { sent, post } = await setup();
    expect(await post(event(), { secret: "wrong" })).toBe(401);
    expect(sent).toEqual([]);
  });

  it("ignores an old timestamp, a repeated delivery id and a sender on its own domain", async () => {
    const { sent, post } = await setup();
    expect(await post(event(), { ts: String(Math.floor(NOW.getTime() / 1000) - 600) })).toBe(200);
    expect(sent).toEqual([]);
    expect(await post(event({ id: "ev2" }))).toBe(200);
    expect(await post(event({ id: "ev2" }))).toBe(200);
    expect(sent).toHaveLength(2);
    expect(await post(event({ id: "ev3", from: "other@mail.test" }))).toBe(200);
    expect(sent).toHaveLength(2);
  });

  it("answers 200 and posts nothing for an unknown agent", async () => {
    const { sent, post } = await setup();
    expect(await post(event({ agent: "nobody" }))).toBe(200);
    expect(sent).toEqual([]);
  });

  it("answers 200 and posts nothing when the mailbox was removed", async () => {
    const { db, sent, post } = await setup();
    await db.update(mailboxes).set({ status: "removed" });
    expect(await post(event())).toBe(200);
    expect(sent).toEqual([]);
  });

  it("ignores other event types, and rejects malformed signatures", async () => {
    const { sent, post } = await setup();
    expect(await post({ ...event({ id: "e5" }), type: "message.sent" })).toBe(200);
    expect(sent).toEqual([]);
    const body = JSON.stringify(event({ id: "e6" }));
    for (const signature of ["zz-not-hex", "abcd", ""]) {
      const r = await fetch(`http://127.0.0.1:${(server!.address() as { port: number }).port}/mail/inbound`, { method: "POST", headers: { "x-agentmail-timestamp": String(NOW.getTime() / 1000), "x-agentmail-signature": signature }, body });
      expect(r.status).toBe(401);
    }
    expect(sent).toEqual([]);
  });

  it("accepts a timestamp exactly five minutes old and refuses one a second older", async () => {
    const { sent, post } = await setup();
    const s = NOW.getTime() / 1000;
    expect(await post(event({ id: "b1" }), { ts: String(s - 300) })).toBe(200);
    expect(sent).toHaveLength(2);
    expect(await post(event({ id: "b2" }), { ts: String(s - 301) })).toBe(200);
    expect(sent).toHaveLength(2);
  });

  it("escapes markdown in the sender and subject", async () => {
    const { sent, post } = await setup();
    await post(event({ from: "a@b.com", subject: "[click](http://x.test) *hi* <b>" }));
    expect(sent[0]![1]).toBe("New email to ada@mail.test from a\\@b.com: \\[click\\]\\(http://x.test\\) \\*hi\\* \\<b\\>");
  });

  it("an audit failure for one chat does not stop the notice to the others", async () => {
    const { sent, post } = await setup();
    auditBroken.chat = "c1";
    try {
      expect(await post(event({ id: "a1" }))).toBe(200);
    } finally {
      auditBroken.chat = "";
    }
    expect(sent.map((x) => x[0]).sort()).toEqual(["c1", "c2"]);
  });

  it("keeps other routes working and fails loudly when it cannot mount before json", async () => {
    const { db } = await setup();
    const deps = { db, secretsKey, send: async () => {} };
    const ok = express();
    ok.use(express.json());
    mountMailInbound(ok, deps);
    ok.get("/health", (_q, r) => void r.json({ ok: true }));
    server?.close();
    server = ok.listen(0);
    const r = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/health`);
    expect(await r.json()).toEqual({ ok: true });
    const noJson = express();
    expect(() => mountMailInbound(noJson, deps)).toThrow(/json/);
    expect(() => mountMailInbound({} as express.Application, deps)).toThrow();
  });

  it("mounts before json on Express 5, which startServer uses", async () => {
    const { db } = await setup();
    const req = createRequire(import.meta.url);
    const express5 = req(req.resolve("express", { paths: [req.resolve("@microsoft/agents-hosting-express")] })) as typeof express;
    const app5 = express5();
    app5.use(express5.json());
    mountMailInbound(app5, { db, secretsKey, send: async () => {} });
    const names = (app5 as unknown as { router: { stack: { name: string; route?: { path: string } }[] } }).router.stack.map((l) => l.route?.path ?? l.name);
    expect(names.indexOf("/mail/inbound")).toBeLessThan(names.indexOf("jsonParser"));
  });

  it("does not retry-loop when Teams fails", async () => {
    const { db } = await setup();
    const failing = express();
    failing.use(express.json());
    mountMailInbound(failing, { db, secretsKey, send: async () => { throw new Error("teams down"); }, now: () => NOW });
    server?.close();
    server = failing.listen(0);
    const port = (server.address() as { port: number }).port;
    const body = JSON.stringify(event({ id: "ev9" }));
    const ts = String(Math.floor(NOW.getTime() / 1000));
    const r = await fetch(`http://127.0.0.1:${port}/mail/inbound`, { method: "POST", headers: { "x-agentmail-timestamp": ts, "x-agentmail-signature": createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex") }, body });
    expect(r.status).toBe(200);
  });
});
