import { beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { assignToChat, upsertDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { testDb } from "../db/test-db.js";
import { botDefinitions, people, workflowRunEvents, workflowRuns, workflows } from "../db/schema.js";
import { DirectoryError } from "../org/directory.js";
import { upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import type { WorkflowGraph } from "./graph.js";
import { createWorkflow, discardDraft, draftHash, emailWorkflowFor, listVersions, publish, publishedGraph, restoreVersion, runsOnRemovedNodes, saveDraft, StaleDraft } from "./store.js";

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

  it("a refused publish leaves every run untouched, even when another stranded node is mapped", async () => {
    await saveDraft(db, "t1", wfId, graph({ minutes: 60 }));
    await publish(db, "t1", wfId, personId, {});
    const mapped = await addRun("w1", "waiting");
    const unmapped = await addRun("gone", "ready");
    await saveDraft(db, "t1", wfId, graph(null, true));
    await expect(publish(db, "t1", wfId, personId, { w1: "ai2" })).rejects.toThrow("Choose where runs on gone go");
    expect(await runOf(mapped)).toMatchObject({ nodeId: "w1", status: "waiting" });
    expect(await runOf(unmapped)).toMatchObject({ nodeId: "gone", status: "ready" });
    expect(await db.select().from(workflowRunEvents)).toEqual([]);
  });

  it("a run parked as needs_person by one publish does not block the next", async () => {
    await saveDraft(db, "t1", wfId, graph({ minutes: 60 }));
    await publish(db, "t1", wfId, personId, {});
    const r = await addRun("w1", "waiting");
    await saveDraft(db, "t1", wfId, graph(null));
    await publish(db, "t1", wfId, personId, { w1: "needs_person" });
    expect(await runsOnRemovedNodes(db, "t1", wfId)).toEqual([]);
    await saveDraft(db, "t1", wfId, graph(null, true));
    expect(await publish(db, "t1", wfId, personId, {})).toBe(3);
    expect(await runOf(r)).toMatchObject({ nodeId: "w1", status: "needs_person" });
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

  it("publish moves a run onto a wait (gets dueAt) and onto an ask (parked)", async () => {
    await saveDraft(db, "t1", wfId, graph(null, true));
    await publish(db, "t1", wfId, personId, {});
    const r1 = await addRun("ai2", "ready");
    const r2 = await addRun("ai2", "ready");
    const g = graph({ minutes: 60 });
    g.nodes.push({ ...b, id: "k", label: "Ask Bob", type: "ask", question: "ok?", choices: ["yes"], timeoutMinutes: 5 });
    g.edges.push({ from: "w1", exit: "new_message", to: "k" }, { from: "k", exit: "yes", to: "e" });
    await saveDraft(db, "t1", wfId, g);
    await publish(db, "t1", wfId, personId, { ai2: "w1" });
    expect(await runOf(r1)).toMatchObject({ nodeId: "w1", status: "waiting" });
    expect((await runOf(r1)).dueAt).toBeInstanceOf(Date);
    await saveDraft(db, "t1", wfId, graph(null, true));
    await publish(db, "t1", wfId, personId, { w1: "ai2" });
    await db.update(workflowRuns).set({ nodeId: "ai2", status: "ready" }).where(eq(workflowRuns.id, r2));
    await saveDraft(db, "t1", wfId, g);
    await publish(db, "t1", wfId, personId, { ai2: "k" });
    expect((await runOf(r2)).status).toBe("needs_person");
    expect((await db.select().from(workflowRunEvents).where(eq(workflowRunEvents.runId, r2))).map((e) => e.reason)).toContain("moved onto an Ask step");
  });

  it("publish refuses to move a run onto the trigger", async () => {
    await saveDraft(db, "t1", wfId, graph({ minutes: 60 }));
    await publish(db, "t1", wfId, personId, {});
    const r = await addRun("w1", "waiting");
    await saveDraft(db, "t1", wfId, graph(null));
    await expect(publish(db, "t1", wfId, personId, { w1: "t" })).rejects.toThrow("Runs can't be moved onto the trigger");
    expect((await runOf(r)).nodeId).toBe("w1");
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

  const draftOf = async () => (await db.select().from(workflows).where(eq(workflows.id, wfId)))[0].draft;

  it("save refuses a stale base", async () => {
    const base = await saveDraft(db, "t1", wfId, graph(null));
    expect(base).toBe(draftHash(await draftOf()));
    await saveDraft(db, "t1", wfId, graph({ minutes: 5 }), base);
    await expect(saveDraft(db, "t1", wfId, graph(null, true), base)).rejects.toThrow(StaleDraft);
    expect(await draftOf()).toEqual(graph({ minutes: 5 }));
  });

  it("discard restores the published graph, or the empty one", async () => {
    await saveDraft(db, "t1", wfId, graph(null));
    await discardDraft(db, "t1", wfId);
    expect(await draftOf()).toEqual({ nodes: [], edges: [], holidays: [] });
    await saveDraft(db, "t1", wfId, graph(null));
    await publish(db, "t1", wfId, personId, {});
    await saveDraft(db, "t1", wfId, graph(null, true));
    await discardDraft(db, "t1", wfId);
    expect(await draftOf()).toEqual(graph(null));
  });

  it("listVersions lists newest first with live flag, and restoreVersion copies one into the draft", async () => {
    await saveDraft(db, "t1", wfId, graph(null));
    await publish(db, "t1", wfId, personId, {});
    await saveDraft(db, "t1", wfId, graph(null, true));
    await publish(db, "t1", wfId, personId, {});
    const vs = await listVersions(db, "t1", wfId);
    expect(vs.map((v) => [v.version, v.live, v.publishedBy])).toEqual([[2, true, "Ann"], [1, false, "Ann"]]);
    expect(vs[0].publishedAt).toBeInstanceOf(Date);
    await restoreVersion(db, "t1", wfId, 1);
    expect(await draftOf()).toEqual(graph(null));
    await expect(restoreVersion(db, "t1", wfId, 9)).rejects.toThrow("No such version");
  });

  it("checkPeople rejects a person outside the tenant", async () => {
    await upsertTenant(db, { id: "t2" });
    const other = (await upsertPerson(db, { tenantId: "t2", aadObjectId: "a2", name: "Zed" })).id;
    const g = graph(null);
    g.nodes.push({ ...b, id: "k", label: "Ask Zed", type: "ask", question: "ok?", choices: ["yes"], personId: other, timeoutMinutes: 5 });
    g.edges.push({ from: "a", exit: "needs_person", to: "k" }, { from: "k", exit: "yes", to: "e" });
    await saveDraft(db, "t1", wfId, g);
    await expect(publish(db, "t1", wfId, personId, {})).rejects.toThrow(`"Ask Zed" asks someone who isn't in this company`);
  });

  it("publish refuses an Ask step naming an unlicensed person", async () => {
    const gone = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "a-unlic", name: "Una" })).id;
    await db.update(people).set({ licensed: false }).where(eq(people.id, gone));
    const g = graph(null);
    g.nodes.push({ ...b, id: "k", label: "Ask Una", type: "ask", question: "ok?", choices: ["yes"], personId: gone, timeoutMinutes: 5 });
    g.edges.push({ from: "a", exit: "needs_person", to: "k" }, { from: "k", exit: "yes", to: "e" });
    await saveDraft(db, "t1", wfId, g);
    await expect(publish(db, "t1", wfId, personId, {})).rejects.toThrow(`"Ask Una" asks someone who isn't in this company`);
  });

  it("publishing an email workflow turns act mode off", async () => {
    await db.update(botDefinitions).set({ mailMode: "act" }).where(eq(botDefinitions.id, defId));
    await saveDraft(db, "t1", wfId, graph(null));
    await publish(db, "t1", wfId, personId, {});
    expect((await db.select().from(botDefinitions).where(eq(botDefinitions.id, defId)))[0].mailMode).toBe("notify");
  });
});
