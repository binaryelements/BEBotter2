import { describe, expect, it } from "vitest";
import { upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { testDb } from "../db/test-db.js";
import { workflowRunEvents, workflowRuns } from "../db/schema.js";
import { assignToChat, upsertDefinition } from "../bots/definitions.js";
import { randomBytes } from "node:crypto";
import { createWorkflow } from "./store.js";
import { tracePath } from "./trace.js";

describe("tracePath", () => {
  it("follows a run through two steps with results", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: "t-trace" });
    const bot = (await upsertDefinition(db, randomBytes(32), "t-trace", { name: "b", label: "B", persona: "p" })).id;
    await upsertChat(db, { id: "c-trace", tenantId: "t-trace", conversationType: "groupChat" });
    await assignToChat(db, "c-trace", bot);
    const ann = (await upsertPerson(db, { tenantId: "t-trace", aadObjectId: "a", name: "Ann" })).id;
    const wid = (await createWorkflow(db, "t-trace", { definitionId: bot, name: "w", chatId: "c-trace", runAsPersonId: ann })).id;
    const runId = "r1";
    await db.insert(workflowRuns).values({ id: runId, tenantId: "t-trace", workflowId: wid, nodeId: "w1", status: "waiting", keys: { threadIds: [], emails: [], domain: null }, fields: {}, title: "Acme" });
    const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n));
    const ev = (n: number, nodeId: string, kind: string, extra: { result?: string; reason?: string } = {}) => ({ id: `e${n}`, runId, nodeId, kind, at: at(n), ...extra });
    await db.insert(workflowRunEvents).values([
      ev(0, "t", "event"),
      ev(1, "a", "step"),
      ev(2, "a", "result", { result: "done", reason: "all clear" }),
      ev(3, "w1", "wait"),
    ]);
    const t = await tracePath(db, "t-trace", runId);
    expect(t).toMatchObject({ runId, title: "Acme", status: "waiting" });
    expect(t.steps).toEqual([
      { nodeId: "a", at: at(1).toISOString(), result: "done", reason: "all clear" },
      { nodeId: "w1", at: at(3).toISOString(), result: null, reason: null },
    ]);
  });
});
