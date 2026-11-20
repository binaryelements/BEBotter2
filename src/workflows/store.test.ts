import { beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { assignToChat, upsertDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { testDb } from "../db/test-db.js";
import { botDefinitions, workflowRunEvents, workflowRuns, workflows } from "../db/schema.js";
import { DirectoryError } from "../org/directory.js";
import { upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import type { WorkflowGraph } from "./graph.js";
import { createWorkflow, emailWorkflowFor, publish, publishedGraph, runsOnRemovedNodes, saveDraft } from "./store.js";

const b = { x: 0, y: 0 };
const aiNode = (id: string, label: string) => ({ ...b, id, label, type: "ai" as const, instruction: "do", success: "ok", results: [{ name: "done", meaning: "done" }] });
// t -> a -> (w1 | ai2 | e) -> e
const graph = (wait: { minutes: number } | null, ai2 = false): WorkflowGraph => ({
  nodes: [
    { ...b, id: "t", label: "Start", type: "trigger", trigger: "email" },
    aiNode("a", "Read"),
    ...(wait ? [{ ...b, id: "w1", label: "Wait a bit", type: "wait" as const, minutes: wait.minutes, businessHours: false }] : []),
    ...(ai2 ? [aiNode("ai2", "Second")] : []),
    { ...b, id: "e", label: "Fin", type: "end", outcome: "fin" },
  ],
  edges: [
    { from: "t", exit: "next", to: "a" },
    { from: "a", exit: "done", to: wait ? "w1" : ai2 ? "ai2" : "e" },
    ...(wait ? [{ from: "w1", exit: "time_up", to: "e" }] : []),
    ...(ai2 ? [{ from: "ai2", exit: "done", to: "e" }] : []),
  ],
  holidays: [],
});

describe("workflow store", () => {
  let db: Db;
  let defId: string;
  let personId: string;
  let wfId: string;
  beforeEach(async () => {
    db = await testDb();
    await upsertTenant(db, { id: "t1" });
    defId = (await upsertDefinition(db, randomBytes(32), "t1", { name: "ops", label: "Ops", persona: "p" })).id;
    await upsertChat(db, { id: "c1", tenantId: "t1", conversationType: "groupChat" });
    await upsertChat(db, { id: "c2", tenantId: "t1", conversationType: "groupChat" });
    await assignToChat(db, "c1", defId);
    personId = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "a1", name: "Ann" })).id;
    wfId = (await createWorkflow(db, "t1", { definitionId: defId, name: "wf", chatId: "c1", runAsPersonId: personId })).id;
  });
  const addRun = async (nodeId: string, status: string, extra: Partial<typeof workflowRuns.$inferInsert> = {}) => {
    const id = crypto.randomUUID();
    await db.insert(workflowRuns).values({ id, tenantId: "t1", workflowId: wfId, nodeId, status, keys: { threadIds: [], emails: [], domain: null }, fields: {}, title: "r", ...extra });
    return id;
  };
  const runOf = async (id: string) => (await db.select().from(workflowRuns).where(eq(workflowRuns.id, id)))[0];

  it("refuses a person bot and an unassigned chat", async () => {
    await db.update(botDefinitions).set({ identity: "person" }).where(eq(botDefinitions.id, defId));
    await expect(createWorkflow(db, "t1", { definitionId: defId, name: "x", chatId: "c1", runAsPersonId: personId })).rejects.toThrow(DirectoryError);
    await db.update(botDefinitions).set({ identity: "service" }).where(eq(botDefinitions.id, defId));
    await expect(createWorkflow(db, "t1", { definitionId: defId, name: "x", chatId: "c2", runAsPersonId: personId })).rejects.toThrow("not assigned");
  });

  it("publish refuses an unmapped removed node and changes nothing", async () => {
    await saveDraft(db, "t1", wfId, graph({ minutes: 60 }));
    await publish(db, "t1", wfId, personId, {});
    await addRun("w1", "waiting", { waitStartedAt: new Date(), dueAt: new Date() });
    await saveDraft(db, "t1", wfId, graph(null));
    expect(await runsOnRemovedNodes(db, "t1", wfId)).toEqual([{ nodeId: "w1", runIds: [expect.any(String)] }]);
    await expect(publish(db, "t1", wfId, personId, {})).rejects.toThrow("Choose where runs on Wait a bit go");
    const [w] = await db.select().from(workflows).where(eq(workflows.id, wfId));
    expect(w.publishedVersion).toBe(1);
  });

  it("publish moves runs", async () => {
    await saveDraft(db, "t1", wfId, graph({ minutes: 60 }));
    await publish(db, "t1", wfId, personId, {});
    const r1 = await addRun("w1", "waiting");
    await saveDraft(db, "t1", wfId, graph(null, true));
    expect(await publish(db, "t1", wfId, personId, { w1: "ai2" })).toBe(2);
    expect(await runOf(r1)).toMatchObject({ nodeId: "ai2", status: "ready" });
    expect((await db.select().from(workflowRunEvents).where(eq(workflowRunEvents.runId, r1))).map((e) => e.kind)).toEqual(["move"]);
    expect(await publishedGraph(db, wfId)).toEqual(graph(null, true));
  });

  it("publish moves runs to needs_person", async () => {
    await saveDraft(db, "t1", wfId, graph({ minutes: 60 }));
    await publish(db, "t1", wfId, personId, {});
    const r = await addRun("w1", "waiting");
    await saveDraft(db, "t1", wfId, graph(null));
    await publish(db, "t1", wfId, personId, { w1: "needs_person" });
    expect((await runOf(r)).status).toBe("needs_person");
  });

  it("publish recalculates a changed wait", async () => {
    await saveDraft(db, "t1", wfId, graph({ minutes: 60 }));
    await publish(db, "t1", wfId, personId, {});
    const start = new Date("2026-11-20T00:00:00Z");
    const id = await addRun("w1", "waiting", { waitStartedAt: start, dueAt: new Date(start.getTime() + 60 * 60000) });
    await saveDraft(db, "t1", wfId, graph({ minutes: 120 }));
    await publish(db, "t1", wfId, personId, {});
    expect((await runOf(id)).dueAt?.getTime()).toBe(start.getTime() + 120 * 60000);
  });

  it("one email workflow per bot", async () => {
    await saveDraft(db, "t1", wfId, graph(null));
    await publish(db, "t1", wfId, personId, {});
    expect((await emailWorkflowFor(db, defId))?.id).toBe(wfId);
    const other = await createWorkflow(db, "t1", { definitionId: defId, name: "wf2", chatId: "c1", runAsPersonId: personId });
    await saveDraft(db, "t1", other.id, graph(null));
    await expect(publish(db, "t1", other.id, personId, {})).rejects.toThrow("already has a workflow");
  });
});
