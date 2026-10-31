import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { auditEvents, botDefinitions, chatAssignments, chats, mailboxes } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { upsertTenant } from "../org/org.js";
import { encrypt } from "../secrets/cipher.js";
import { mountMailInbound } from "./inbound.js";

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
    expect(sent[0]![1]).toBe("New email to ada@mail.test from bob@example.com: Invoice attached");
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
