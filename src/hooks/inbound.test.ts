import { describe, expect, it } from "vitest";
import express from "express";
import { eq } from "drizzle-orm";
import { assignToChat, upsertDefinition } from "../bots/definitions.js";
import { testDb } from "../db/test-db.js";
import { botDefinitions } from "../db/schema.js";
import { setRole } from "../org/directory.js";
import { saveConversationReference, upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { encrypt } from "../secrets/cipher.js";
import { serve } from "../admin/test-server.js";
import { hookNotice, mountInboundHook, readPayload, receiveHook } from "./inbound.js";

const key = Buffer.alloc(32, 5);

async function setup() {
  const db = await testDb();
  await upsertTenant(db, { id: "t1" });
  const admin = await upsertPerson(db, { tenantId: "t1", aadObjectId: "a1", name: "Ann" });
  await setRole(db, "t1", admin.id, "admin");
  const def = await upsertDefinition(db, key, "t1", { name: "ops", label: "Ops", persona: "p" });
  for (const id of ["c1", "c2"]) {
    await upsertChat(db, { id, tenantId: "t1", conversationType: "groupChat" });
    await saveConversationReference(db, id, { conversation: { id } });
    await assignToChat(db, id, def.id);
  }
  const sent: [string, string][] = [];
  const deps = { db, secretsKey: key, send: async (chatId: string, m: string) => void sent.push([chatId, m]) };
  const hook = async (secret = "s3cret") => {
    await db.update(botDefinitions).set({ inboundSecret: encrypt(key, secret), inboundBy: admin.id }).where(eq(botDefinitions.id, def.id));
    return secret;
  };
  return { db, def, admin, deps, sent, hook };
}

describe("inbound webhook", () => {
  it("hands what arrived to the bot in every chat it is in, with sender and subject", async () => {
    const s = await setup();
    const secret = await s.hook();
    const r = await receiveHook(s.deps, s.def.id, secret, { from: "fax@eml.binaryelements.com", subject: "Fax sent", text: "1 page to 07 4920 6200 at 12:25" });
    expect(r.status).toBe(202);
    await r.deliver!();
    const want = "Webhook from fax@eml.binaryelements.com: Fax sent\n\n1 page to 07 4920 6200 at 12:25";
    expect(s.sent).toEqual([["c1", want], ["c2", want]]);
    const [row] = await s.db.select().from(botDefinitions).where(eq(botDefinitions.id, s.def.id));
    expect([row.inboundHits, row.inboundAt instanceof Date]).toEqual([1, true]);
  });

  it("takes a plain-text body, and posts it with no sender named", async () => {
    const s = await setup();
    const secret = await s.hook();
    const r = await receiveHook(s.deps, s.def.id, secret, "the backup finished");
    expect(r.status).toBe(202);
    await r.deliver!();
    expect(s.sent.map(([id, m]) => [id, m])).toEqual([
      ["c1", "Webhook from an outside system\n\nthe backup finished"],
      ["c2", "Webhook from an outside system\n\nthe backup finished"],
    ]);
  });

  it("refuses a wrong secret, an unknown bot, a bot with no URL, and an empty body", async () => {
    const s = await setup();
    await s.hook();
    expect((await receiveHook(s.deps, s.def.id, "wrong", { text: "x" })).status).toBe(401);
    expect((await receiveHook(s.deps, "nope", "s3cret", { text: "x" })).status).toBe(404);
    expect((await receiveHook(s.deps, s.def.id, "s3cret", {})).status).toBe(400);
    await s.db.update(botDefinitions).set({ inboundSecret: null }).where(eq(botDefinitions.id, s.def.id));
    expect((await receiveHook(s.deps, s.def.id, "s3cret", { text: "x" })).status).toBe(404);
  });
});

describe("hook endpoint", () => {
  it("takes JSON a global parser already read, plain text it did not, and refuses a wrong or unknown URL", async () => {
    const s = await setup();
    const secret = await s.hook();
    const app = express();
    app.use(express.json()); // the Teams SDK installs this before every route
    mountInboundHook(app, s.deps);
    const { url, close } = await serve(app);
    try {
      const send = (path: string, type: string, body: string) => fetch(`${url}/hooks/${path}`, { method: "POST", headers: { "content-type": type }, body });
      expect((await send(`${s.def.id}/${secret}`, "application/json", JSON.stringify({ text: "a fax went out" }))).status).toBe(202);
      expect((await send(`${s.def.id}/${secret}`, "text/plain", "the backup finished")).status).toBe(202);
      expect((await send(`${s.def.id}/wrong`, "application/json", '{"text":"x"}')).status).toBe(401);
      expect((await send("nope/nope", "application/json", '{"text":"x"}')).status).toBe(404);
    } finally {
      await close();
    }
  });
});

describe("hook payload", () => {
  it("reads text, message, body or content, and keeps from and subject", () => {
    expect(readPayload({ text: "a" })).toEqual({ text: "a" });
    expect(readPayload({ message: "b" })).toEqual({ text: "b" });
    expect(readPayload({ body: "c", from: "x@y", subject: "s" })).toEqual({ text: "c", from: "x@y", subject: "s" });
    expect(readPayload({ content: "d" })).toEqual({ text: "d" });
    expect(readPayload({ text: "   " })).toBeUndefined();
    expect(readPayload("  plain  ")).toEqual({ text: "plain" });
  });

  it("writes the notice the bot's people read, and keeps it a sane length", () => {
    expect(hookNotice({ text: "body" })).toBe("Webhook from an outside system\n\nbody");
    expect(hookNotice({ text: "body", from: "a@b", subject: "s" })).toBe("Webhook from a@b: s\n\nbody");
    expect(hookNotice({ text: "x".repeat(9000) }).length).toBeLessThanOrEqual(9000);
  });
});
