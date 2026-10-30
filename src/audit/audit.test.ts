import { describe, expect, it } from "vitest";
import { upsertDefinition } from "../bots/definitions.js";
import { testDb } from "../db/test-db.js";
import type { Db } from "../db/client.js";
import { upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { eq } from "drizzle-orm";
import { auditEvents } from "../db/schema.js";
import { beginAction, completeAction, listActions, pruneAudit, recordAuthority, summarise } from "./audit.js";

async function setup(db: Db) {
  await upsertTenant(db, { id: "t1" });
  await upsertChat(db, { id: "c1", tenantId: "t1", conversationType: "groupChat" });
  await upsertChat(db, { id: "c2", tenantId: "t1", conversationType: "groupChat" });
  const def = await upsertDefinition(db, Buffer.alloc(32, 5), "t1", { name: "ops", label: "Ops", persona: "You run ops." });
  const person = await upsertPerson(db, { tenantId: "t1", aadObjectId: "a1", name: "Ann" });
  return { chatId: "c1", definitionId: def.id, personId: person.id };
}

describe("audit", () => {
  it("records authority on a pending row without finishing it", async () => {
    const db = await testDb();
    const ids = await setup(db);
    const id = await beginAction(db, { tenantId: "t1", ...ids, kind: "tool", toolName: "mcp__x__y", summary: "y" });
    await recordAuthority(db, id, { type: "confirmation", personId: ids.personId });
    const [row] = await listActions(db, { tenantId: "t1" });
    expect(row).toMatchObject({ status: "pending", finishedAt: null, authority: { type: "confirmation", personId: ids.personId } });
  });

  it("begins a pending row with startedAt set and finishedAt null", async () => {
    const db = await testDb();
    const ids = await setup(db);
    const id = await beginAction(db, { tenantId: "t1", ...ids, kind: "tool", toolName: "mcp__computer__bash", toolInput: { command: "ls -la" }, summary: "ls -la" });
    const [row] = await listActions(db, { tenantId: "t1" });
    expect(row.id).toBe(id);
    expect(row.status).toBe("pending");
    expect(row.startedAt).toBeInstanceOf(Date);
    expect(row.finishedAt).toBeNull();
  });

  it("completes with authority, cost and finishedAt", async () => {
    const db = await testDb();
    const ids = await setup(db);
    const id = await beginAction(db, { tenantId: "t1", ...ids, kind: "tool", toolName: "mcp__tickets__close_ticket", summary: "close_ticket {}" });
    await completeAction(db, id, { status: "done", authority: { type: "confirmation", personId: ids.personId }, costUsd: 0.0123 });
    const [row] = await listActions(db, { tenantId: "t1" });
    expect(row.status).toBe("done");
    expect(row.authority).toEqual({ type: "confirmation", personId: ids.personId });
    expect(row.costUsd).toBe("0.012300");
    expect(row.finishedAt).toBeInstanceOf(Date);
  });

  it("filters the list by chatId", async () => {
    const db = await testDb();
    const ids = await setup(db);
    await beginAction(db, { tenantId: "t1", ...ids, kind: "message", summary: "in c1" });
    await beginAction(db, { tenantId: "t1", ...ids, chatId: "c2", kind: "message", summary: "in c2" });
    const rows = await listActions(db, { tenantId: "t1", chatId: "c2" });
    expect(rows.map((r) => r.summary)).toEqual(["in c2"]);
  });

  it("summarises bash commands, other MCP tools and plain tools", () => {
    expect(summarise("mcp__computer__bash", { command: "ls -la" })).toBe("ls -la");
    expect(summarise("mcp__computer__bash", { command: "x".repeat(300) })).toHaveLength(200);
    expect(summarise("mcp__tickets__close_ticket", { id: 7 })).toBe('close_ticket {"id":7}');
    expect(summarise("mcp__computer__bash", "not an object")).toBe("mcp__computer__bash");
    expect(summarise("WebSearch", { query: "x" })).toBe("WebSearch");
  });
});

describe("audit filters and prune", () => {
  it("filters by personIds, status and before; pending rows and other tenants survive prune", async () => {
    const db = await testDb();
    const ids = await setup(db);
    await upsertTenant(db, { id: "t2" });
    await upsertChat(db, { id: "c9", tenantId: "t2", conversationType: "groupChat" });
    const other = await upsertDefinition(db, Buffer.alloc(32, 5), "t2", { name: "o", label: "O", persona: "" });
    const old = new Date(Date.now() - 40 * 86_400_000);
    const mk = async (tenantId: string, chatId: string, definitionId: string, status: "done" | "failed" | "pending", at: Date) => {
      const id = await beginAction(db, { tenantId, chatId, definitionId, personId: ids.personId, kind: "message", summary: status });
      if (status !== "pending") await completeAction(db, id, { status });
      await db.update(auditEvents).set({ startedAt: at, ...(status === "pending" ? {} : { finishedAt: at }) }).where(eq(auditEvents.id, id));
      return id;
    };
    await mk("t1", "c1", ids.definitionId, "done", old);
    await mk("t1", "c1", ids.definitionId, "pending", old);
    await mk("t1", "c1", ids.definitionId, "failed", new Date());
    await mk("t2", "c9", other.id, "done", old);
    expect(await listActions(db, { tenantId: "t1", personIds: [] })).toEqual([]);
    expect(await listActions(db, { tenantId: "t1", personIds: [ids.personId], status: "failed" })).toHaveLength(1);
    const newest = (await listActions(db, { tenantId: "t1" }))[0];
    expect(await listActions(db, { tenantId: "t1", before: newest.id })).toHaveLength(2);
    expect(await listActions(db, { tenantId: "t1", before: "nope" })).toHaveLength(3);
    expect(await pruneAudit(db, "t1", 30)).toBe(1);
    expect(await listActions(db, { tenantId: "t1" })).toHaveLength(2);
    expect(await listActions(db, { tenantId: "t2" })).toHaveLength(1);
  });
});
