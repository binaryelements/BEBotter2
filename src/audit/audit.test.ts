import { describe, expect, it } from "vitest";
import { upsertDefinition } from "../bots/definitions.js";
import { testDb } from "../db/test-db.js";
import type { Db } from "../db/client.js";
import { upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { beginAction, completeAction, listActions, recordAuthority, summarise } from "./audit.js";

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
