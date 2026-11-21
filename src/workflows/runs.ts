import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { auditEvents, workflowPending, workflowRunEvents, workflowRuns, workflows } from "../db/schema.js";
import type { Workflow, WorkflowRun } from "../db/schema.js";
import type { Db } from "../db/client.js";
import { DirectoryError } from "../org/directory.js";
import { getTenantSettings } from "../org/org.js";
import { NEEDS_PERSON, NEW_MESSAGE, nextNode } from "./graph.js";
import type { AskNode, WorkflowNode } from "./graph.js";
import { waitUntil } from "./hours.js";
import { plain } from "../teams/cards.js";
import { publishedGraph } from "./store.js";
import type { QueuedEvent, RunEvent } from "./types.js";

export type { RunEvent } from "./types.js";
export type Notify = (chatId: string, text: string) => Promise<void>;

export let postAskHook: (run: WorkflowRun, node: AskNode) => Promise<void> = async () => {};
/** Task 9 sets this to post the Ask card and create its pending row. */
export function setPostAsk(fn: typeof postAskHook): void {
  postAskHook = fn;
}

type Entry = { status: string; dueAt: Date | null; waitStartedAt: Date | null; stepStartedAt: null; reportedResult: null; attempts?: number; outcome?: string | null; endedAt?: Date | null };

/** The run fields a node sets when a run lands on it. */
export function nodeEntry(node: WorkflowNode, now: Date, timezone: string, holidays: string[]): Entry {
  const e = nodeFields(node, now, timezone, holidays);
  return { ...e, stepStartedAt: null, reportedResult: null };
}

function nodeFields(node: WorkflowNode, now: Date, timezone: string, holidays: string[]): Omit<Entry, "stepStartedAt" | "reportedResult"> {
  switch (node.type) {
    case "ai": return { status: "ready", dueAt: null, waitStartedAt: null, attempts: 0 };
    case "wait": return { status: "waiting", dueAt: waitUntil(now, node.minutes, node.businessHours, timezone, holidays), waitStartedAt: now };
    case "ask": return { status: "waiting", dueAt: new Date(now.getTime() + node.timeoutMinutes * 60_000), waitStartedAt: now };
    case "end": return { status: "done", dueAt: null, waitStartedAt: null, outcome: node.outcome, endedAt: now };
    case "trigger": return { status: "ready", dueAt: null, waitStartedAt: null };
  }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type After = (() => Promise<void>)[];

const addEvent = (tx: Tx, runId: string, nodeId: string, kind: string, extra: { result?: string; reason?: string; data?: unknown } = {}) =>
  tx.insert(workflowRunEvents).values({ id: crypto.randomUUID(), runId, nodeId, kind, ...extra });

const lock = async (tx: Tx, runId: string) => (await tx.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).for("update"))[0] as WorkflowRun | undefined;

async function context(tx: Tx, run: WorkflowRun) {
  const [wf] = await tx.select().from(workflows).where(eq(workflows.id, run.workflowId));
  return { wf, graph: await publishedGraph(tx as unknown as Db, run.workflowId) };
}

/** Runs `fn` on the locked run row in one transaction; notifications and the ask hook fire after it commits. */
async function atomically(db: Db, runId: string, fn: (tx: Tx, run: WorkflowRun, after: After) => Promise<void>): Promise<void> {
  const after: After = [];
  await db.transaction(async (tx) => {
    const run = await lock(tx, runId);
    if (run) await fn(tx, run, after);
  });
  for (const f of after) await f();
}

export async function startRun(
  db: Db,
  wf: Workflow,
  input: { title: string; keys: WorkflowRun["keys"]; fields?: Record<string, string>; event: RunEvent },
  notify: Notify = async () => {},
): Promise<WorkflowRun> {
  const trigger = (await publishedGraph(db, wf.id))?.nodes.find((n) => n.type === "trigger");
  if (!trigger) throw new DirectoryError("This workflow is not published");
  const after: After = [];
  const id = crypto.randomUUID();
  await db.transaction(async (tx) => {
    // The starting email is not a reply, so it is queued as already used.
    const [run] = await tx
      .insert(workflowRuns)
      .values({ id, tenantId: wf.tenantId, workflowId: wf.id, nodeId: trigger.id, status: "ready", keys: input.keys, fields: input.fields ?? {}, pendingEvents: [{ ...input.event, woke: true }], title: input.title })
      .returning();
    await addEvent(tx, id, trigger.id, "event", { data: input.event });
    await step(tx, run, "next", notify, undefined, after);
  });
  for (const f of after) await f();
  const [fresh] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id));
  return fresh;
}

// A call acts only if the locked row is still where the caller saw it; a concurrent call that got there first wins.
// `claim`: also the same claim of the step (its stepStartedAt), so a turn whose lease ran out cannot act for a newer claim.
const stillThere = (cur: WorkflowRun, seen: WorkflowRun, claim?: Date | null) =>
  cur.nodeId === seen.nodeId && cur.status === seen.status && (claim === undefined || cur.stepStartedAt?.getTime() === claim?.getTime());

/**
 * True only if the run moved. `dueBy`: act only if the run is still due by then, so a run that came back to the same node with a fresh dueAt waits again.
 * `untouched`: act only if the run's updatedAt is still the one in `run`, so a run that left and came back to the same node is not moved.
 */
export const takeExit = async (db: Db, run: WorkflowRun, exit: string, notify: Notify, reason?: string, dueBy?: Date, untouched?: boolean): Promise<boolean> => {
  let moved = false;
  await atomically(db, run.id, async (tx, cur, after) => {
    if (dueBy && !(cur.dueAt && cur.dueAt <= dueBy)) return;
    if (untouched && cur.updatedAt.getTime() !== run.updatedAt.getTime()) return;
    if (!stillThere(cur, run)) return;
    await step(tx, cur, exit, notify, reason, after);
    moved = true;
  });
  return moved;
};

/**
 * The queued events of a run running on `nodeId`, for its step's prompt. They are marked `inStep` and stay queued
 * (a retry, a re-run after a restart or a step resumed after an approval sees them again) until settleStep drops them.
 */
export async function takeQueuedEvents(db: Db, runId: string, nodeId: string): Promise<QueuedEvent[]> {
  let taken: QueuedEvent[] = [];
  await atomically(db, runId, async (tx, run) => {
    if (run.nodeId !== nodeId || run.status !== "running") return;
    taken = run.pendingEvents.map((e) => ({ ...e, inStep: true }));
    await tx.update(workflowRuns).set({ pendingEvents: taken }).where(eq(workflowRuns.id, runId));
  });
  return taken;
}

/** Ends an AI step: drops the events it was given and takes `exit`, in one transaction. A no-op unless `run`'s claim still holds. */
export const settleStep = (db: Db, run: WorkflowRun, exit: string, notify: Notify, reason?: string) =>
  atomically(db, run.id, async (tx, cur, after) => {
    if (!stillThere(cur, run, run.stepStartedAt)) return;
    const [kept] = await tx.update(workflowRuns).set({ pendingEvents: cur.pendingEvents.filter((e) => !e.inStep) }).where(eq(workflowRuns.id, run.id)).returning();
    await step(tx, kept, exit, notify, reason, after);
  });

export const enterNode = (db: Db, run: WorkflowRun, nodeId: string, notify: Notify, reason?: string) =>
  atomically(db, run.id, async (tx, cur, after) => {
    if (stillThere(cur, run)) await enter(tx, cur, nodeId, notify, reason, after);
  });

async function step(tx: Tx, run: WorkflowRun, exit: string, notify: Notify, reason: string | undefined, after: After): Promise<void> {
  const { graph } = await context(tx, run);
  const next = graph ? nextNode(graph, run.nodeId, exit) : NEEDS_PERSON;
  await addEvent(tx, run.id, run.nodeId, "result", { result: exit, reason });
  // a reply that came during the step was never seen; here and not in enter, so a person can still move a run to an end
  const unseen = graph?.nodes.find((n) => n.id === next)?.type === "end" && run.pendingEvents.some((e) => !e.woke && !e.inStep);
  const to = unseen ? NEEDS_PERSON : next;
  const why = unseen ? "a new message arrived as it ended" : (reason ?? (to === NEEDS_PERSON && exit !== NEEDS_PERSON ? `nothing is connected to "${exit}"` : undefined));
  await enter(tx, run, to, notify, why, after);
}

async function enter(tx: Tx, run: WorkflowRun, nodeId: string, notify: Notify, reason: string | undefined, after: After): Promise<void> {
  const { wf, graph } = await context(tx, run);
  // leaving an ask by any exit closes its card, so a late click says closed
  await tx.update(workflowPending).set({ status: "cancelled" }).where(and(eq(workflowPending.runId, run.id), eq(workflowPending.nodeId, run.nodeId), eq(workflowPending.kind, "ask"), eq(workflowPending.status, "pending")));
  const node = nodeId === NEEDS_PERSON ? undefined : graph?.nodes.find((n) => n.id === nodeId);
  if (!node || !graph) {
    const why = nodeId === NEEDS_PERSON ? (reason ?? "it needs a person") : "its step no longer exists";
    await tx.update(workflowRuns).set({ status: "needs_person", dueAt: null, reportedResult: null, updatedAt: new Date() }).where(eq(workflowRuns.id, run.id));
    await addEvent(tx, run.id, run.nodeId, "needs_person", { reason: why });
    const label = graph?.nodes.find((n) => n.id === run.nodeId)?.label ?? run.nodeId;
    after.push(() => notify(wf.chatId, `${plain(run.title)} needs a person at ${label}: ${plain(why)}`));
    return;
  }
  const tz = (await getTenantSettings(tx as unknown as Db, run.tenantId)).timezone;
  const now = new Date();
  const [updated] = await tx
    .update(workflowRuns)
    .set({ ...nodeEntry(node, now, tz, graph.holidays), nodeId: node.id, updatedAt: now })
    .where(eq(workflowRuns.id, run.id))
    .returning();
  await addEvent(tx, run.id, node.id, node.type === "wait" ? "wait" : node.type === "ask" ? "ask" : "step", { reason, data: node.type === "end" ? { outcome: node.outcome } : undefined });
  if (node.type !== "wait" && node.type !== "ask") return;
  if (updated.pendingEvents.some((e) => !e.woke)) {
    // Events stay queued for the AI step; marking them woke keeps one email from waking a second wait.
    const marked = updated.pendingEvents.map((e) => ({ ...e, woke: true }));
    const [next] = await tx.update(workflowRuns).set({ pendingEvents: marked }).where(eq(workflowRuns.id, run.id)).returning();
    await step(tx, next, NEW_MESSAGE, notify, undefined, after);
    return;
  }
  if (node.type === "ask") after.push(() => postAskHook(updated, node));
}

/**
 * Nothing is sent after the customer replied: the run's held approvals, and answered ones not yet used, are cancelled, and
 * the held calls' audit rows denied, so the step's no-write retry runs and wroteSince doesn't count a call that never ran.
 */
export async function revokeApprovals(tx: Tx, runId: string): Promise<void> {
  const revoked = await tx
    .update(workflowPending)
    .set({ status: "cancelled" })
    .where(and(eq(workflowPending.runId, runId), eq(workflowPending.kind, "approval"), or(eq(workflowPending.status, "pending"), and(inArray(workflowPending.status, ["approved", "declined"]), isNull(workflowPending.answer)))))
    .returning({ auditId: workflowPending.auditId });
  const held = revoked.flatMap((r) => (r.auditId ? [r.auditId] : []));
  if (held.length)
    await tx.update(auditEvents).set({ status: "denied", error: "Not run: the customer replied before it was approved.", finishedAt: new Date() }).where(and(inArray(auditEvents.id, held), eq(auditEvents.status, "pending")));
}

/** The bare lowercased address of a sender that may be written "Name <addr>". */
export const emailAddress = (from: string) => (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
export const emailDomain = (address: string) => address.slice(address.lastIndexOf("@") + 1);

/** The run's keys with an email's thread and lowercased sender added, so later mail on them finds the run. */
function withEmail(keys: WorkflowRun["keys"], event: RunEvent): WorkflowRun["keys"] {
  if (event.type !== "email") return keys;
  const from = emailAddress(event.from);
  return {
    threadIds: event.threadId ? [...new Set([...keys.threadIds, event.threadId])] : keys.threadIds,
    emails: [...new Set([...keys.emails, from])],
    domain: keys.domain ?? emailDomain(from),
  };
}

/** False if the run has ended, so nothing was delivered. */
export async function deliverEvent(db: Db, runId: string, event: RunEvent, notify: Notify): Promise<boolean> {
  let delivered = false;
  await atomically(db, runId, async (tx, run, after) => {
    if (run.status === "done" || run.status === "failed") return;
    delivered = true;
    const { wf, graph } = await context(tx, run);
    await addEvent(tx, run.id, run.nodeId, "event", { data: event });
    const keys = withEmail(run.keys, event);
    const waiting = run.status === "waiting";
    const queued: QueuedEvent = { ...event, woke: waiting };
    const [updated] = await tx
      .update(workflowRuns)
      .set({ keys, pendingEvents: [...run.pendingEvents, queued], updatedAt: new Date() })
      .where(eq(workflowRuns.id, run.id))
      .returning();
    await revokeApprovals(tx, run.id);
    if (waiting) {
      // ask cards only: a pending email-match question is about another email and stays open
      await tx.update(workflowPending).set({ status: "cancelled" }).where(and(eq(workflowPending.runId, run.id), eq(workflowPending.kind, "ask"), eq(workflowPending.status, "pending")));
      await step(tx, updated, NEW_MESSAGE, notify, undefined, after);
    } else if (run.status === "needs_person") {
      const label = graph?.nodes.find((n) => n.id === run.nodeId)?.label ?? run.nodeId;
      after.push(() => notify(wf.chatId, `${plain(run.title)} needs a person at ${label}: a new message arrived`));
    }
  });
  return delivered;
}

/** Reopens an ended run for a new email: it needs a person, with the email queued. False if the run is not ended. */
export async function reopenRun(db: Db, runId: string, event: RunEvent, notify: Notify): Promise<boolean> {
  let reopened = false;
  await atomically(db, runId, async (tx, run, after) => {
    if (run.status !== "done" && run.status !== "failed") return;
    reopened = true;
    const { wf } = await context(tx, run);
    // shortcut: reopen lands on needs a person; part 2's status page moves it to a chosen step
    await tx
      .update(workflowRuns)
      .set({ status: "needs_person", outcome: null, endedAt: null, dueAt: null, keys: withEmail(run.keys, event), pendingEvents: [...run.pendingEvents, { ...event, woke: false }], updatedAt: new Date() })
      .where(eq(workflowRuns.id, run.id));
    await addEvent(tx, run.id, run.nodeId, "event", { data: event, reason: "reopened by a new email" });
    after.push(() => notify(wf.chatId, `${plain(run.title)} was reopened by a new email and needs a person.`));
  });
  return reopened;
}

export async function moveRun(db: Db, tenantId: string, runId: string, nodeId: string, personId: string, notify: Notify): Promise<void> {
  const [found] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.tenantId, tenantId)));
  if (!found) throw new DirectoryError("No such run");
  const graph = await publishedGraph(db, found.workflowId);
  const target = graph?.nodes.find((n) => n.id === nodeId);
  if (!target) throw new DirectoryError("No such step");
  if (target.type === "trigger") throw new DirectoryError("Runs can't be moved onto the trigger");
  await atomically(db, runId, async (tx, run, after) => {
    if (run.status !== "needs_person") throw new DirectoryError("Only a run that needs a person can be moved");
    await addEvent(tx, run.id, run.nodeId, "move", { data: { from: run.nodeId, to: nodeId, personId } });
    await enter(tx, run, nodeId, notify, undefined, after);
  });
}

/** Runs `fn` on a run a person may stop: not running a step, not ended. */
async function stoppable(db: Db, tenantId: string, runId: string, fn: (tx: Tx, run: WorkflowRun) => Promise<void>): Promise<void> {
  const [found] = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.tenantId, tenantId)));
  if (!found) throw new DirectoryError("No such run");
  await atomically(db, runId, async (tx, run) => {
    if (run.status === "running") throw new DirectoryError("Wait for the step to finish");
    if (run.status === "done" || run.status === "failed") throw new DirectoryError("This run has ended");
    await fn(tx, run);
  });
}

/** Parks a ready or waiting run as needs_person; a person then moves it on with moveRun. */
export const pauseRun = (db: Db, tenantId: string, runId: string, personId: string) =>
  stoppable(db, tenantId, runId, async (tx, run) => {
    if (run.status === "needs_person") return;
    await tx.update(workflowRuns).set({ status: "needs_person", dueAt: null, updatedAt: new Date() }).where(eq(workflowRuns.id, run.id));
    await addEvent(tx, run.id, run.nodeId, "move", { reason: "paused", data: { from: run.nodeId, to: NEEDS_PERSON, personId } });
  });

/** Ends an open run by hand, closing its cards and revoking its held approvals. */
export const endRun = (db: Db, tenantId: string, runId: string, personId: string) =>
  stoppable(db, tenantId, runId, async (tx, run) => {
    const now = new Date();
    await tx.update(workflowRuns).set({ status: "done", dueAt: null, outcome: "ended by a person", endedAt: now, updatedAt: now }).where(eq(workflowRuns.id, run.id));
    await tx.update(workflowPending).set({ status: "cancelled" }).where(and(eq(workflowPending.runId, run.id), eq(workflowPending.kind, "ask"), eq(workflowPending.status, "pending")));
    await revokeApprovals(tx, run.id);
    await addEvent(tx, run.id, run.nodeId, "move", { reason: "ended", data: { from: run.nodeId, to: "end", personId } });
  });
