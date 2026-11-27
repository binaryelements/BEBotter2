import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { upsertDefinition } from "../bots/definitions.js";
import { testDb } from "../db/test-db.js";
import { turnLogs } from "../db/schema.js";
import { maskSecrets } from "../knowledge/secrets-scan.js";
import { upsertChat, upsertTenant } from "../org/org.js";
import type { EngineMessage } from "./engine.js";
import { forLog, pruneTurnLogs, saveTurnLog, sentCountOf } from "./turn-log.js";

describe("turn logs", () => {
  it("masks secret-looking values and keeps the rest", () => {
    expect(maskSecrets("password: hunter2 and the plan is Core 4")).toBe("password: [redacted] and the plan is Core 4");
    expect(maskSecrets("key ghp_abcdefghijklmnopqrstuvwxyz1234 here")).toBe("key [redacted] here");
    expect(maskSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\nafter")).toBe("[redacted]\nafter");
    expect(maskSecrets("password: <yours>")).toBe("password: <yours>");
  });

  it("drops image bytes, cuts long tool results and masks tool inputs", () => {
    const messages: EngineMessage[] = [
      { role: "user", text: "hi", images: [{ data: "AAAA", mimeType: "image/png" }] },
      { role: "assistant", toolCalls: [{ id: "a", name: "mcp__x__y", input: { nested: { secret: "token=abc999" }, n: 3 } }] },
      { role: "tool", toolCallId: "a", text: "y".repeat(20_500) },
    ];
    const [user, call, tool] = forLog(messages);
    expect(user).toEqual({ role: "user", text: "hi", images: undefined });
    expect(call).toEqual({ role: "assistant", toolCalls: [{ id: "a", name: "mcp__x__y", input: { nested: { secret: "token=[redacted]" }, n: 3 } }] });
    expect(tool!.role === "tool" && tool!.text.endsWith("[cut: 1 KB more]")).toBe(true);
  });

  it("counts as sent everything up to this turn's own message", () => {
    const messages: EngineMessage[] = [
      { role: "user", text: "earlier" },
      { role: "assistant", text: "ok" },
      { role: "user", text: "now" },
      { role: "assistant", text: "done" },
    ];
    expect(sentCountOf(messages, "now")).toBe(3);
    expect(sentCountOf(messages, "missing")).toBe(0);
  });

  it("deletes a tenant's logs older than 30 days and keeps newer ones", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: "t1" });
    await upsertChat(db, { id: "c1", tenantId: "t1", conversationType: "groupChat" });
    const def = await upsertDefinition(db, Buffer.alloc(32, 5), "t1", { name: "ops", label: "Ops", persona: "p" });
    const result = { messages: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, stopReason: "text" as const };
    const base = { tenantId: "t1", definitionId: def.id, chatId: "c1", startedBy: "Ann", model: "m", systemPrompt: "s", prompt: "p", result };
    const old = await saveTurnLog(db, base);
    const recent = await saveTurnLog(db, base);
    await db.update(turnLogs).set({ createdAt: new Date(Date.now() - 31 * 86_400_000) }).where(eq(turnLogs.id, old!));
    await db.update(turnLogs).set({ createdAt: new Date(Date.now() - 29 * 86_400_000) }).where(eq(turnLogs.id, recent!));
    expect(await pruneTurnLogs(db, "t1")).toBe(1);
    expect((await db.select({ id: turnLogs.id }).from(turnLogs)).map((r) => r.id)).toEqual([recent]);
  });
});
