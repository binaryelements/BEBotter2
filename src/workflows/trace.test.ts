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

  it("pairs each visit: revisits, moves and tied timestamps", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: "t-trace2" });
    const bot = (await upsertDefinition(db, randomBytes(32), "t-trace2", { name: "b", label: "B", persona: "p" })).id;
    await upsertChat(db, { id: "c-trace2", tenantId: "t-trace2", conversationType: "groupChat" });
    await assignToChat(db, "c-trace2", bot);
    const ann = (await upsertPerson(db, { tenantId: "t-trace2", aadObjectId: "a", name: "Ann" })).id;
    const wid = (await createWorkflow(db, "t-trace2", { definitionId: bot, name: "w", chatId: "c-trace2", runAsPersonId: ann })).id;
    const run = async (id: string, evs: [number, string, string, { result?: string; reason?: string }?][]) => {
      await db.insert(workflowRuns).values({ id, tenantId: "t-trace2", workflowId: wid, nodeId: "a", status: "waiting", keys: { threadIds: [], emails: [], domain: null }, fields: {}, title: id });
      await db.insert(workflowRunEvents).values(evs.map(([n, nodeId, kind, x], i) => ({ id: `${id}-${i}`, runId: id, nodeId, kind, at: new Date(Date.UTC(2026, 0, 1, 0, n)), ...x })));
      return (await tracePath(db, "t-trace2", id)).steps.map((s) => [s.nodeId, s.result, s.reason]);
    };
    // entered twice with a result between: each visit keeps its own result
    expect(await run("loop", [[1, "a", "step"], [2, "a", "result", { result: "x", reason: "first" }], [3, "w", "wait"], [4, "a", "step"], [5, "a", "result", { result: "y", reason: "second" }]]))
      .toEqual([["a", "x", "first"], ["w", null, null], ["a", "y", "second"]]);
    // revisit with no result between (a person moved it off): the old visit stays open-ended
    expect(await run("moved", [[1, "a", "step"], [2, "a", "move", { reason: "paused" }], [3, "a", "step"], [4, "a", "result", { result: "z" }]]))
      .toEqual([["a", null, "paused"], ["a", "z", null]]);
    // result(prev) and step(next) share an instant: the result still belongs to prev
    expect(await run("tie", [[1, "a", "step"], [2, "w", "wait"], [2, "a", "result", { result: "t" }], [3, "w", "result", { result: "u" }]]))
      .toEqual([["a", "t", null], ["w", "u", null]]);
  });
});
