import { describe, expect, it, vi } from "vitest";
import express from "express";
import { assignToChat, upsertDefinition } from "../bots/definitions.js";
import { testDb } from "../db/test-db.js";
import { botDefinitions } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { setRole } from "../org/directory.js";
import { saveConversationReference, upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import type { AdaptiveCard } from "../teams/cards.js";
import type { RunTurnInput } from "../engine/runner.js";
import { encrypt } from "../secrets/cipher.js";
import { serve } from "../admin/test-server.js";
import { hookPrompt, mountInboundHook, readPayload, receiveHook } from "./inbound.js";

const key = Buffer.alloc(32, 5);

async function setup() {
  const db = await testDb();
  await upsertTenant(db, { id: "t1" });
  const admin = await upsertPerson(db, { tenantId: "t1", aadObjectId: "a1", name: "Ann" });
  await setRole(db, "t1", admin.id, "admin");
  const def = await upsertDefinition(db, key, "t1", { name: "ops", label: "Ops", persona: "p" });
  await upsertChat(db, { id: "c1", tenantId: "t1", conversationType: "groupChat" });
  await saveConversationReference(db, "c1", { conversation: { id: "c1" } });
  await assignToChat(db, "c1", def.id);
  const sent: [string, string | AdaptiveCard][] = [];
  const turns: RunTurnInput[] = [];
  const runTurn = vi.fn(async (turn: RunTurnInput) => {
    turns.push(turn);
    return { text: "Nothing to do.", costUsd: 0, sessionId: "s", changed: false, auditId: "none", timings: { receivedAt: new Date().toISOString(), tools: 0 } };
  });
  const deps = { db, secretsKey: key, runTurn, send: async (chatId: string, m: string | AdaptiveCard) => void sent.push([chatId, m]) };
  const hook = async (secret = "s3cret") => {
    await db.update(botDefinitions).set({ inboundSecret: encrypt(key, secret), inboundChatId: "c1", inboundBy: admin.id }).where(eq(botDefinitions.id, def.id));
    return secret;
  };
  return { db, def, admin, deps, sent, turns, hook };
}

describe("inbound webhook", () => {
  it("runs a turn with what arrived and answers in the chat the admin picked", async () => {
    const s = await setup();
    const secret = await s.hook();
    const r = await receiveHook(s.deps, s.def.id, secret, { from: "fax@eml.binaryelements.com", subject: "Fax sent", text: "1 page to 07 4920 6200 at 12:25" });
    expect(r.status).toBe(202);
    await r.run!();
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0].text).toContain("1 page to 07 4920 6200 at 12:25");
    expect(s.turns[0].text).toContain("From: fax@eml.binaryelements.com");
    expect(s.sent).toEqual([["c1", "**Ops**\n\nNothing to do."]]);
  });

  it("takes a plain-text body and counts what it received", async () => {
    const s = await setup();
    const secret = await s.hook();
    const r = await receiveHook(s.deps, s.def.id, secret, "the backup finished");
    expect(r.status).toBe(202);
    const [row] = await s.db.select().from(botDefinitions).where(eq(botDefinitions.id, s.def.id));
    expect(row.inboundHits).toBe(1);
    expect(row.inboundAt).toBeInstanceOf(Date);
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

describe("hook payload", () => {  it("reads text, message, body or content, and keeps from and subject", () => {
    expect(readPayload({ text: "a" })).toEqual({ text: "a" });
    expect(readPayload({ message: "b" })).toEqual({ text: "b" });
    expect(readPayload({ body: "c", from: "x@y", subject: "s" })).toEqual({ text: "c", from: "x@y", subject: "s" });
    expect(readPayload({ content: "d" })).toEqual({ text: "d" });
    expect(readPayload({ text: "   " })).toBeUndefined();
    expect(readPayload("  plain  ")).toEqual({ text: "plain" });
  });

  it("tells the bot this came from outside, and stays inside the routine prompt limit", () => {
    const p = hookPrompt({ text: "x".repeat(9000), subject: "s" });
    expect(p).toContain("inbound webhook");
    expect(p).toContain("Subject: s");
    expect(p.length).toBeLessThanOrEqual(4000);
  });
});
