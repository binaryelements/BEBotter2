import { beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { assignToChat, upsertDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { testDb } from "../db/test-db.js";
import { workflowPending, workflowRuns } from "../db/schema.js";
import type { Workflow, WorkflowRun } from "../db/schema.js";
import { upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import type { AdaptiveCard } from "../teams/cards.js";
import { answerAsk, postAsk } from "./ask.js";
import { tickWorkflows } from "./engine.js";
import type { AskNode, WorkflowGraph } from "./graph.js";
import { deliverEvent, setPostAsk, startRun } from "./runs.js";
import { createWorkflow, publish, saveDraft } from "./store.js";

const b = { x: 0, y: 0 };
const graph = (personId?: string): WorkflowGraph => ({
  nodes: [
    { ...b, id: "t", label: "Start", type: "trigger", trigger: "manual" },
    { ...b, id: "k", label: "Ask", type: "ask", question: "Ship it?", choices: ["yes", "no"], timeoutMinutes: 30, ...(personId ? { personId } : {}) },
    { ...b, id: "y", label: "Yes", type: "end", outcome: "shipped" },
    { ...b, id: "n", label: "No", type: "end", outcome: "held" },
    { ...b, id: "q", label: "Quiet", type: "end", outcome: "nobody answered" },
    { ...b, id: "r", label: "Replied", type: "end", outcome: "replied" },
  ],
  edges: [
    { from: "t", exit: "next", to: "k" },
    { from: "k", exit: "yes", to: "y" },
    { from: "k", exit: "no", to: "n" },
    { from: "k", exit: "no_answer", to: "q" },
    { from: "k", exit: "new_message", to: "r" },
  ],
  holidays: [],
});

const looping = (): WorkflowGraph => {
  const g = graph();
  return { ...g, nodes: g.nodes.filter((n) => n.id !== "q"), edges: g.edges.map((e) => (e.exit === "no_answer" ? { ...e, to: "k" } : e)) };
};

describe("ask a person", () => {
  let db: Db;
  let wf: Workflow;
  let defId: string;
  let ann: string;
  let bob: string;
  let sent: (string | AdaptiveCard)[];
  const notify = async () => {};
  const reload = async (r: WorkflowRun) => (await db.select().from(workflowRuns).where(eq(workflowRuns.id, r.id)))[0]!;
  const pending = async (r: WorkflowRun) => db.select().from(workflowPending).where(eq(workflowPending.runId, r.id));
  const start = () => startRun(db, wf, { title: "PO-7", keys: { threadIds: [], emails: [], domain: null }, event: { type: "manual", fields: {} } });
  const publishGraph = async (g: WorkflowGraph) => {
    await saveDraft(db, "t1", wf.id, g);
    await publish(db, "t1", wf.id, ann, {});
  };

  beforeEach(async () => {
    sent = [];
    db = await testDb();
    await upsertTenant(db, { id: "t1" });
    defId = (await upsertDefinition(db, randomBytes(32), "t1", { name: "ops", label: "Ops", persona: "p" })).id;
    await upsertChat(db, { id: "c1", tenantId: "t1", conversationType: "groupChat" });
    await assignToChat(db, "c1", defId);
    ann = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "a1", name: "Ann" })).id;
    bob = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "b1", name: "Bob" })).id;
    wf = await createWorkflow(db, "t1", { definitionId: defId, name: "wf", chatId: "c1", runAsPersonId: ann });
    setPostAsk((run, node) => postAsk(db, async (_c, m) => void sent.push(m), run, node));
    await publishGraph(graph());
  });

  it("an ask node posts a card and waits", async () => {
    const r = await start();
    expect(await reload(r)).toMatchObject({ nodeId: "k", status: "waiting" });
    const [row] = await pending(r);
    expect(row).toMatchObject({ nodeId: "k", kind: "ask", choices: ["yes", "no"], askPersonId: null, status: "pending" });
    const json = JSON.stringify(sent[0]);
    expect(json).toContain("Ship it?");
    expect(json).toContain("PO-7");
    expect(json).toContain(`"verb":"wfask"`);
    expect(json).toContain(`"data":{"pendingId":"${row!.id}","choice":"no"}`);
  });

  it("an answer takes that choice's exit", async () => {
    const r = await start();
    const [row] = await pending(r);
    expect(await answerAsk(db, row!.id, ann, "Ann", "no", notify)).toBe("no, by Ann");
    expect(await reload(r)).toMatchObject({ nodeId: "n", status: "done" });
    expect((await pending(r))[0]).toMatchObject({ status: "answered", answeredByPersonId: ann, answer: "no" });
  });

  it("a second answer says closed", async () => {
    const r = await start();
    const [row] = await pending(r);
    await answerAsk(db, row!.id, ann, "Ann", "yes", notify);
    expect(await answerAsk(db, row!.id, ann, "Ann", "no", notify)).toBe("This question has closed.");
    expect(await reload(r)).toMatchObject({ nodeId: "y" });
  });

  it("someone else can't answer a node with personId", async () => {
    await publishGraph(graph(bob));
    const r = await start();
    const [row] = await pending(r);
    expect(row!.askPersonId).toBe(bob);
    expect(await answerAsk(db, row!.id, ann, "Ann", "yes", notify)).toBe("You can't answer this question.");
    expect(await reload(r)).toMatchObject({ nodeId: "k", status: "waiting" });
    expect(await answerAsk(db, row!.id, bob, "Bob", "yes", notify)).toBe("yes, by Bob");
  });

  it("a choice not on the card is refused", async () => {
    const r = await start();
    const [row] = await pending(r);
    expect(await answerAsk(db, row!.id, ann, "Ann", "maybe", notify)).toBe("That isn't one of the choices.");
    expect((await pending(r))[0]!.status).toBe("pending");
  });

  it("an answer after the run moved on says closed", async () => {
    const r = await start();
    const [row] = await pending(r);
    await db.update(workflowPending).set({ status: "pending" }).where(eq(workflowPending.id, row!.id));
    // a reply cancels the card and moves the run
    await deliverEvent(db, r.id, { type: "email", from: "c@acme.com", subject: "hi", messageId: "m2", threadId: null }, notify);
    expect(await answerAsk(db, row!.id, ann, "Ann", "yes", notify)).toBe("This question has closed.");
    // the row is still pending but the run is elsewhere: cancelled, not answered
    await db.update(workflowPending).set({ status: "pending" }).where(eq(workflowPending.id, row!.id));
    expect(await answerAsk(db, row!.id, ann, "Ann", "yes", notify)).toBe("This question has closed.");
    expect((await pending(r))[0]!.status).toBe("cancelled");
    expect(await reload(r)).toMatchObject({ nodeId: "r" });
  });

  it("no_answer cancels the pending row", async () => {
    const r = await start();
    await tickWorkflows({ db, send: async () => {}, runTurn: async () => { throw new Error("no step"); } }, new Date(Date.now() + 31 * 60_000));
    expect(await reload(r)).toMatchObject({ nodeId: "q" });
    const [row] = await pending(r);
    expect(row!.status).toBe("cancelled");
    expect(await answerAsk(db, row!.id, ann, "Ann", "yes", notify)).toBe("This question has closed.");
  });

  it("takeExit says whether it moved the run, and can require the run untouched", async () => {
    const { takeExit } = await import("./runs.js");
    const r = await start();
    const seen = await reload(r);
    await db.update(workflowRuns).set({ updatedAt: new Date(Date.now() + 5000) }).where(eq(workflowRuns.id, r.id));
    expect(await takeExit(db, seen, "yes", notify, undefined, undefined, true)).toBe(false);
    expect(await takeExit(db, await reload(r), "yes", notify, undefined, undefined, true)).toBe(true);
    expect(await takeExit(db, seen, "yes", notify)).toBe(false);
  });

  it("no_answer looping back to the same ask keeps the new card pending", async () => {
    await publishGraph(looping());
    const r = await start();
    const [old] = await pending(r);
    await tickWorkflows({ db, send: async (_c, m) => void sent.push(m), runTurn: async () => { throw new Error("no step"); } }, new Date(Date.now() + 31 * 60_000));
    const rows = await pending(r);
    expect(rows.find((p) => p.id === old!.id)!.status).toBe("cancelled");
    expect(rows.filter((p) => p.status === "pending")).toHaveLength(1);
  });

  it("a title from an email shows literally: a TextRun in the card, escaped in the text fallback", async () => {
    const evil = "[Approve](http://evil) (x@evil.test)";
    const r = await startRun(db, wf, { title: evil, keys: { threadIds: [], emails: [], domain: null }, event: { type: "manual", fields: {} } });
    const json = JSON.stringify(sent[0]);
    expect(json).toContain(JSON.stringify({ type: "TextRun", text: evil, weight: "Bolder" }));
    expect(json).not.toContain(`"type":"TextBlock"`);
    const texts: string[] = [];
    await postAsk(db, async (_c, m) => { if (typeof m !== "string") throw new Error("teams down"); texts.push(m); }, await reload(r), graph().nodes[1] as AskNode);
    expect(texts).toEqual(["Couldn't post the question for \\[Approve\\]\\(http://evil\\) \\(x\\@evil.test\\): Ship it?"]);
  });

  it("a failed send posts the plain-text notice and leaves the run waiting", async () => {
    const texts: (string | AdaptiveCard)[] = [];
    setPostAsk((run, node) => postAsk(db, async (_c, m) => { if (typeof m !== "string") throw new Error("teams down"); texts.push(m); }, run, node));
    const r = await start();
    expect(texts).toEqual(["Couldn't post the question for PO-7: Ship it?"]);
    expect(await reload(r)).toMatchObject({ nodeId: "k", status: "waiting" });
  });
});

describe("email-match questions", () => {
  let db: Db;
  let wf: Workflow;
  let ann: string;
  const notes: string[] = [];
  const notify = async (_c: string, t: string) => void notes.push(t);
  const mail = { type: "email" as const, from: "Sue@acme.com", subject: "Another PO", messageId: "m9", threadId: "th9" };
  const reload = async (id: string) => (await db.select().from(workflowRuns).where(eq(workflowRuns.id, id)))[0]!;
  const start = () => startRun(db, wf, { title: "PO-7", keys: { threadIds: [], emails: ["bob@acme.com"], domain: "acme.com" }, event: { type: "manual", fields: {} } });
  const addMatch = async (r: WorkflowRun, choices: string[]) => {
    const id = crypto.randomUUID();
    await db.insert(workflowPending).values({ id, runId: r.id, nodeId: r.nodeId, kind: "match", choices, input: mail });
    return id;
  };

  beforeEach(async () => {
    notes.length = 0;
    db = await testDb();
    await upsertTenant(db, { id: "t1" });
    const defId = (await upsertDefinition(db, randomBytes(32), "t1", { name: "ops", label: "Ops", persona: "p" })).id;
    await upsertChat(db, { id: "c1", tenantId: "t1", conversationType: "groupChat" });
    await assignToChat(db, "c1", defId);
    ann = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "a1", name: "Ann" })).id;
    wf = await createWorkflow(db, "t1", { definitionId: defId, name: "wf", chatId: "c1", runAsPersonId: ann });
    setPostAsk((run, node) => postAsk(db, async () => {}, run, node));
    await saveDraft(db, "t1", wf.id, graph());
    await publish(db, "t1", wf.id, ann, {});
  });

  it("Attach delivers the email to the run; a second answer is closed", async () => {
    const r = await start();
    const id = await addMatch(await reload(r.id), ["Attach", "Start new"]);
    expect(await answerAsk(db, id, ann, "Ann", "Attach", notify)).toBe("Attach, by Ann");
    const after = await reload(r.id);
    expect(after).toMatchObject({ nodeId: "r", status: "done" }); // the ask's new_message exit
    expect(after.keys).toMatchObject({ threadIds: ["th9"], emails: ["bob@acme.com", "sue@acme.com"] });
    expect(await answerAsk(db, id, ann, "Ann", "Start new", notify)).toBe("This question has closed.");
    expect(await db.select().from(workflowRuns)).toHaveLength(1);
  });

  it("Reopen puts an ended run on needs a person with the email queued", async () => {
    const r = await start();
    const [ask] = await db.select().from(workflowPending).where(eq(workflowPending.runId, r.id));
    await answerAsk(db, ask!.id, ann, "Ann", "yes", notify);
    const id = await addMatch(await reload(r.id), ["Reopen", "Start new"]);
    expect(await answerAsk(db, id, ann, "Ann", "Reopen", notify)).toBe("Reopen, by Ann");
    const after = await reload(r.id);
    expect(after).toMatchObject({ status: "needs_person", outcome: null, endedAt: null });
    expect(after.pendingEvents.at(-1)).toEqual({ ...mail, woke: false });
    expect(notes).toContain("PO-7 was reopened by a new email and needs a person.");
  });

  it("notices escape a title taken from an email", async () => {
    const r = await start();
    await db.update(workflowRuns).set({ title: "[Approve](http://evil)", status: "done" }).where(eq(workflowRuns.id, r.id));
    const id = await addMatch(await reload(r.id), ["Reopen", "Start new"]);
    await answerAsk(db, id, ann, "Ann", "Reopen", notify);
    expect(notes).toEqual(["\\[Approve\\]\\(http://evil\\) was reopened by a new email and needs a person."]);
  });

  it("Start new starts a run titled by the email, and Attach to a run that ended meanwhile does too", async () => {
    const r = await start();
    const id = await addMatch(await reload(r.id), ["Attach", "Start new"]);
    expect(await answerAsk(db, id, ann, "Ann", "Start new", notify)).toBe("Start new, by Ann");
    const runs = await db.select().from(workflowRuns);
    expect(runs).toHaveLength(2);
    expect(runs.find((x) => x.id !== r.id)).toMatchObject({ title: "Another PO (Sue@acme.com)", keys: { threadIds: ["th9"], emails: ["sue@acme.com"], domain: "acme.com" } });
    expect((await reload(r.id)).status).toBe("waiting");

    await db.update(workflowRuns).set({ status: "done" }).where(eq(workflowRuns.id, r.id));
    const late = await addMatch(await reload(r.id), ["Attach", "Start new"]);
    expect(await answerAsk(db, late, ann, "Ann", "Attach", notify)).toBe("Attach, by Ann");
    expect(await db.select().from(workflowRuns)).toHaveLength(3);
  });

  it("someone without write access can't answer", async () => {
    const r = await start();
    const id = await addMatch(await reload(r.id), ["Attach", "Start new"]);
    const eve = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "e1", name: "Eve" })).id;
    expect(await answerAsk(db, id, eve, "Eve", "Attach", notify)).toBe("You can't answer this question.");
  });

  it("a reply that wakes the run leaves its match question open", async () => {
    const r = await start();
    const id = await addMatch(await reload(r.id), ["Attach", "Start new"]);
    await deliverEvent(db, r.id, { type: "email", from: "bob@acme.com", subject: "re", messageId: "m2", threadId: null }, notify);
    expect((await db.select().from(workflowPending).where(eq(workflowPending.id, id)))[0]!.status).toBe("pending");
  });
});
