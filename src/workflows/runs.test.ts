import { beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { assignToChat, upsertDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { testDb } from "../db/test-db.js";
import { workflowPending, workflowRunEvents, workflowRuns } from "../db/schema.js";
import type { Workflow, WorkflowRun } from "../db/schema.js";
import { upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import type { WorkflowGraph } from "./graph.js";
import { deliverEvent, enterNode, moveRun, startRun, takeExit } from "./runs.js";
import type { RunEvent } from "./runs.js";
import { createWorkflow, publish, saveDraft } from "./store.js";

const b = { x: 0, y: 0 };
// t -> a -(done)-> w -(time_up)-> e ; w -(new_message)-> a ; a has no needs_person link
const graph: WorkflowGraph = {
  nodes: [
    { ...b, id: "t", label: "Start", type: "trigger", trigger: "email" },
    { ...b, id: "a", label: "Read", type: "ai", instruction: "do", success: "ok", results: [{ name: "done", meaning: "d" }, { name: "stop", meaning: "s" }] },
    { ...b, id: "w", label: "Wait", type: "wait", minutes: 60, businessHours: false },
    { ...b, id: "e", label: "Fin", type: "end", outcome: "all good" },
  ],
  edges: [
    { from: "t", exit: "next", to: "a" },
    { from: "a", exit: "done", to: "w" },
    { from: "a", exit: "stop", to: "e" },
    { from: "w", exit: "time_up", to: "e" },
    { from: "w", exit: "new_message", to: "a" },
  ],
  holidays: [],
};
const email = (n: number, threadId: string | null = null): RunEvent => ({ type: "email", from: `Bob@Acme.com`, subject: `s${n}`, messageId: `m${n}`, threadId });

describe("workflow runs", () => {
  let db: Db;
  let wf: Workflow;
  let personId: string;
  let sent: [string, string][];
  const notify = async (chatId: string, text: string) => void sent.push([chatId, text]);
  const reload = async (r: WorkflowRun) => (await db.select().from(workflowRuns).where(eq(workflowRuns.id, r.id)))[0];
  const start = (event = email(1)) => startRun(db, wf, { title: "Acme order", keys: { threadIds: [], emails: [], domain: null }, event });
  beforeEach(async () => {
    sent = [];
    db = await testDb();
    await upsertTenant(db, { id: "t1" });
    const defId = (await upsertDefinition(db, randomBytes(32), "t1", { name: "ops", label: "Ops", persona: "p" })).id;
    await upsertChat(db, { id: "c1", tenantId: "t1", conversationType: "groupChat" });
    await assignToChat(db, "c1", defId);
    personId = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "a1", name: "Ann" })).id;
    wf = await createWorkflow(db, "t1", { definitionId: defId, name: "wf", chatId: "c1", runAsPersonId: personId });
    await saveDraft(db, "t1", wf.id, graph);
    await publish(db, "t1", wf.id, personId, {});
  });

  it("startRun lands on the first ai step", async () => {
    const r = await start();
    expect(r).toMatchObject({ nodeId: "a", status: "ready", attempts: 0 });
    expect(r.pendingEvents).toHaveLength(1);
  });

  it("takeExit to a wait sets dueAt", async () => {
    const r = await start();
    await takeExit(db, r, "done", notify);
    const w = await reload(r);
    expect(w).toMatchObject({ nodeId: "w", status: "waiting" });
    expect(w.dueAt!.getTime() - w.waitStartedAt!.getTime()).toBe(60 * 60000);
  });

  it("takeExit with dueBy waits for a run whose dueAt is later", async () => {
    const r = await start();
    await takeExit(db, r, "done", notify);
    const w = await reload(r);
    await takeExit(db, w, "time_up", notify, undefined, new Date(w.dueAt!.getTime() - 1));
    expect(await reload(r)).toMatchObject({ nodeId: "w", status: "waiting" });
    await takeExit(db, w, "time_up", notify, undefined, w.dueAt!);
    expect(await reload(r)).toMatchObject({ nodeId: "e", status: "done" });
  });

  it("unconnected exit goes to needs a person and notifies", async () => {
    const r = await start();
    await takeExit(db, r, "needs_person", notify, "cannot tell");
    expect(await reload(r)).toMatchObject({ nodeId: "a", status: "needs_person" });
    expect(sent).toEqual([["c1", "Acme order needs a person at Read: cannot tell"]]);
    const events = await db.select().from(workflowRunEvents).where(eq(workflowRunEvents.runId, r.id));
    expect(events.some((e) => e.kind === "needs_person" && e.reason === "cannot tell")).toBe(true);
  });

  it("end sets done and outcome", async () => {
    const r = await start();
    await takeExit(db, r, "stop", notify);
    const d = await reload(r);
    expect(d).toMatchObject({ nodeId: "e", status: "done", outcome: "all good" });
    expect(d.endedAt).toBeInstanceOf(Date);
  });

  it("deliverEvent on a waiting run takes new_message and cancels its pending card", async () => {
    const r = await start();
    await db.update(workflowRuns).set({ pendingEvents: [] }).where(eq(workflowRuns.id, r.id));
    await takeExit(db, r, "done", notify);
    expect((await reload(r)).status).toBe("waiting");
    await db.insert(workflowPending).values({ id: "p1", runId: r.id, nodeId: "w", kind: "ask" });
    await deliverEvent(db, r.id, email(2, "th1"), notify);
    const after = await reload(r);
    expect(after).toMatchObject({ nodeId: "a", status: "ready" });
    expect(after.pendingEvents).toHaveLength(1);
    expect(after.keys).toEqual({ threadIds: ["th1"], emails: ["bob@acme.com"], domain: "acme.com" });
    expect((await db.select().from(workflowPending))[0].status).toBe("cancelled");
  });

  it("deliverEvent on a ready run queues it", async () => {
    const r = await start();
    await deliverEvent(db, r.id, email(2), notify);
    expect(await reload(r)).toMatchObject({ nodeId: "a", status: "ready", pendingEvents: [{ ...email(1), woke: true }, { ...email(2), woke: false }] });
  });

  it("entering a wait with an unused queued event takes new_message at once", async () => {
    const r = await start();
    await deliverEvent(db, r.id, email(2), notify); // a reply that arrived during the step
    await takeExit(db, r, "done", notify);
    const after = await reload(r);
    expect(after).toMatchObject({ nodeId: "a", status: "ready" });
    expect(after.pendingEvents).toHaveLength(2);
    expect(after.pendingEvents.every((e) => e.woke)).toBe(true);
  });

  const useGraph = async (nodes: WorkflowGraph["nodes"], edges: WorkflowGraph["edges"]) => {
    await saveDraft(db, "t1", wf.id, { nodes, edges, holidays: [] });
    await publish(db, "t1", wf.id, personId, { w: "needs_person", a: "needs_person", t: "needs_person" });
  };
  const trig = { ...b, id: "t", label: "Start", type: "trigger" as const, trigger: "email" as const };
  const ask = { ...b, id: "k", label: "Ask", type: "ask" as const, question: "ok?", choices: ["yes"], timeoutMinutes: 5 };
  const wait = (id: string) => ({ ...b, id, label: id, type: "wait" as const, minutes: 60, businessHours: false });
  const fin = { ...b, id: "e", label: "Fin", type: "end" as const, outcome: "x" };

  it("one email wakes only one wait or ask: wait -> ask -> wait keeps the second wait", async () => {
    await useGraph([trig, wait("w1"), ask, wait("w2"), fin], [
      { from: "t", exit: "next", to: "w1" }, { from: "w1", exit: "new_message", to: "k" }, { from: "w1", exit: "time_up", to: "e" },
      { from: "k", exit: "yes", to: "w2" }, { from: "w2", exit: "time_up", to: "e" },
    ]);
    const r = await start();
    expect(await reload(r)).toMatchObject({ nodeId: "w1", status: "waiting" }); // trigger -> wait keeps the wait
    await deliverEvent(db, r.id, email(2), notify);
    expect(await reload(r)).toMatchObject({ nodeId: "k", status: "waiting" });
    await takeExit(db, await reload(r), "yes", notify);
    expect(await reload(r)).toMatchObject({ nodeId: "w2", status: "waiting" });
  });

  it("trigger -> ask -> wait keeps the wait", async () => {
    await useGraph([trig, ask, wait("w2"), fin], [
      { from: "t", exit: "next", to: "k" }, { from: "k", exit: "yes", to: "w2" }, { from: "w2", exit: "time_up", to: "e" },
    ]);
    const r = await start();
    expect(await reload(r)).toMatchObject({ nodeId: "k", status: "waiting" });
    await takeExit(db, r, "yes", notify);
    expect(await reload(r)).toMatchObject({ nodeId: "w2", status: "waiting" });
  });

  it("two events delivered together are both queued", async () => {
    const r = await start();
    await Promise.all([deliverEvent(db, r.id, email(2), notify), deliverEvent(db, r.id, email(3), notify)]);
    expect((await reload(r)).pendingEvents).toHaveLength(3);
  });

  it("takeExit called twice at once enters the next node once", async () => {
    const r = await start();
    await takeExit(db, r, "done", notify);
    const waiting = await reload(r);
    expect(waiting.status).toBe("waiting");
    await Promise.all([takeExit(db, waiting, "time_up", notify), takeExit(db, waiting, "time_up", notify)]);
    expect(await reload(r)).toMatchObject({ nodeId: "e", status: "done" });
    const steps = await db.select().from(workflowRunEvents).where(eq(workflowRunEvents.runId, r.id));
    expect(steps.filter((e) => e.kind === "step" && e.nodeId === "e")).toHaveLength(1);
  });

  it("moveRun refuses the trigger", async () => {
    const r = await start();
    await takeExit(db, r, "needs_person", notify, "stuck");
    await expect(moveRun(db, "t1", r.id, "t", personId, notify)).rejects.toThrow("Runs can't be moved onto the trigger");
  });

  it("lowercases sender emails in keys", async () => {
    const r = await start();
    await deliverEvent(db, r.id, email(2), notify);
    expect((await reload(r)).keys.emails).toEqual(["bob@acme.com"]);
  });

  it("deliverEvent on a run needing a person queues and notifies; moveRun puts it back", async () => {
    const r = await start();
    await takeExit(db, r, "needs_person", notify, "stuck");
    await deliverEvent(db, r.id, email(2), notify);
    expect(sent[1]).toEqual(["c1", "Acme order needs a person at Read: a new message arrived"]);
    await moveRun(db, "t1", r.id, "e", personId, notify);
    expect(await reload(r)).toMatchObject({ nodeId: "e", status: "done" });
    await expect(moveRun(db, "t1", r.id, "a", personId, notify)).rejects.toThrow("needs a person");
  });

  it("a node missing from the published graph needs a person", async () => {
    const r = await start();
    await enterNode(db, r, "gone", notify);
    expect(sent[0][1]).toBe("Acme order needs a person at Read: its step no longer exists");
  });
});
