import { and, eq } from "drizzle-orm";
import { workflowPending, workflowRunEvents, workflowRuns, workflows } from "../db/schema.js";
import type { Workflow, WorkflowRun } from "../db/schema.js";
import type { Db } from "../db/client.js";
import { DirectoryError } from "../org/directory.js";
import { getTenantSettings } from "../org/org.js";
import { NEEDS_PERSON, NEW_MESSAGE, nextNode } from "./graph.js";
import type { AskNode, WorkflowNode } from "./graph.js";
import { waitUntil } from "./hours.js";
import { publishedGraph } from "./store.js";
import type { RunEvent } from "./types.js";

export type { RunEvent } from "./types.js";
export type Notify = (chatId: string, text: string) => Promise<void>;

export let postAskHook: (run: WorkflowRun, node: AskNode) => Promise<void> = async () => {};
/** Task 9 sets this to post the Ask card and create its pending row. */
export function setPostAsk(fn: typeof postAskHook): void {
  postAskHook = fn;
}

type Entry = { status: string; dueAt: Date | null; waitStartedAt: Date | null; attempts?: number; outcome?: string | null; endedAt?: Date | null };

/** The run fields a node sets when a run lands on it. */
export function nodeEntry(node: WorkflowNode, now: Date, timezone: string, holidays: string[]): Entry {
  switch (node.type) {
    case "ai": return { status: "ready", dueAt: null, waitStartedAt: null, attempts: 0 };
    case "wait": return { status: "waiting", dueAt: waitUntil(now, node.minutes, node.businessHours, timezone, holidays), waitStartedAt: now };
    case "ask": return { status: "waiting", dueAt: new Date(now.getTime() + node.timeoutMinutes * 60_000), waitStartedAt: now };
    case "end": return { status: "done", dueAt: null, waitStartedAt: null, outcome: node.outcome, endedAt: now };
    case "trigger": return { status: "ready", dueAt: null, waitStartedAt: null };
  }
}

const addEvent = (db: Db, runId: string, nodeId: string, kind: string, extra: { result?: string; reason?: string; data?: unknown } = {}) =>
  db.insert(workflowRunEvents).values({ id: crypto.randomUUID(), runId, nodeId, kind, ...extra });

async function context(db: Db, run: WorkflowRun) {
  const [wf] = await db.select().from(workflows).where(eq(workflows.id, run.workflowId));
  return { wf, graph: await publishedGraph(db, run.workflowId) };
}

export async function startRun(
  db: Db,
  wf: Workflow,
  input: { title: string; keys: WorkflowRun["keys"]; fields?: Record<string, string>; event: RunEvent },
  notify: Notify = async () => {},
): Promise<WorkflowRun> {
  const trigger = (await publishedGraph(db, wf.id))?.nodes.find((n) => n.type === "trigger");
  if (!trigger) throw new DirectoryError("This workflow is not published");
  const [run] = await db
    .insert(workflowRuns)
    .values({ id: crypto.randomUUID(), tenantId: wf.tenantId, workflowId: wf.id, nodeId: trigger.id, status: "ready", keys: input.keys, fields: input.fields ?? {}, pendingEvents: [input.event], title: input.title })
    .returning();
  await addEvent(db, run.id, trigger.id, "event", { data: input.event });
  await step(db, run, "next", notify, undefined, true);
  const [fresh] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
  return fresh;
}

export const takeExit = (db: Db, run: WorkflowRun, exit: string, notify: Notify, reason?: string) => step(db, run, exit, notify, reason, false);
export const enterNode = (db: Db, run: WorkflowRun, nodeId: string, notify: Notify, reason?: string) => enter(db, run, nodeId, notify, reason, false);

// `chained` is true once new_message was taken (or the run just started), so a queued event never loops.
async function step(db: Db, run: WorkflowRun, exit: string, notify: Notify, reason: string | undefined, chained: boolean): Promise<void> {
  const { graph } = await context(db, run);
  const to = graph ? nextNode(graph, run.nodeId, exit) : NEEDS_PERSON;
  await addEvent(db, run.id, run.nodeId, "result", { result: exit, reason });
  const why = reason ?? (to === NEEDS_PERSON && exit !== NEEDS_PERSON ? `nothing is connected to "${exit}"` : undefined);
  await enter(db, run, to, notify, why, chained);
}

async function enter(db: Db, run: WorkflowRun, nodeId: string, notify: Notify, reason: string | undefined, chained: boolean): Promise<void> {
  const { wf, graph } = await context(db, run);
  const node = nodeId === NEEDS_PERSON ? undefined : graph?.nodes.find((n) => n.id === nodeId);
  if (!node || !graph) {
    const why = nodeId === NEEDS_PERSON ? (reason ?? "it needs a person") : "its step no longer exists";
    await db.update(workflowRuns).set({ status: "needs_person", dueAt: null, updatedAt: new Date() }).where(eq(workflowRuns.id, run.id));
    await addEvent(db, run.id, run.nodeId, "needs_person", { reason: why });
    const label = graph?.nodes.find((n) => n.id === run.nodeId)?.label ?? run.nodeId;
    await notify(wf.chatId, `${run.title} needs a person at ${label}: ${why}`);
    return;
  }
  const tz = (await getTenantSettings(db, run.tenantId)).timezone;
  const now = new Date();
  const [updated] = await db
    .update(workflowRuns)
    .set({ ...nodeEntry(node, now, tz, graph.holidays), nodeId: node.id, stepStartedAt: null, reportedResult: null, updatedAt: now })
    .where(eq(workflowRuns.id, run.id))
    .returning();
  await addEvent(db, run.id, node.id, node.type === "wait" ? "wait" : node.type === "ask" ? "ask" : "step", { reason, data: node.type === "end" ? { outcome: node.outcome } : undefined });
  if (node.type !== "wait" && node.type !== "ask") return;
  if (updated.pendingEvents.length > 0 && !chained) {
    await step(db, updated, NEW_MESSAGE, notify, undefined, true); // events stay queued for the AI step
    return;
  }
  if (node.type === "ask") await postAskHook(updated, node);
}

export async function deliverEvent(db: Db, runId: string, event: RunEvent, notify: Notify): Promise<void> {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
  if (!run || run.status === "done" || run.status === "failed") return;
  const { wf, graph } = await context(db, run);
  await addEvent(db, run.id, run.nodeId, "event", { data: event });
  const keys = { ...run.keys };
  if (event.type === "email") {
    if (event.threadId) keys.threadIds = [...new Set([...keys.threadIds, event.threadId])];
    keys.emails = [...new Set([...keys.emails, event.from])];
    keys.domain ??= event.from.split("@")[1]?.toLowerCase() ?? null;
  }
  const [queued] = await db
    .update(workflowRuns)
    .set({ keys, pendingEvents: [...run.pendingEvents, event], updatedAt: new Date() })
    .where(eq(workflowRuns.id, run.id))
    .returning();
  if (run.status === "waiting") {
    await db.update(workflowPending).set({ status: "cancelled" }).where(and(eq(workflowPending.runId, run.id), eq(workflowPending.status, "pending")));
    await step(db, queued, NEW_MESSAGE, notify, undefined, true);
  } else if (run.status === "needs_person") {
    const label = graph?.nodes.find((n) => n.id === run.nodeId)?.label ?? run.nodeId;
    await notify(wf.chatId, `${run.title} needs a person at ${label}: a new message arrived`);
  }
}

export async function moveRun(db: Db, tenantId: string, runId: string, nodeId: string, personId: string, notify: Notify): Promise<void> {
  const [run] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.tenantId, tenantId)));
  if (!run) throw new DirectoryError("No such run");
  if (run.status !== "needs_person") throw new DirectoryError("Only a run that needs a person can be moved");
  const graph = await publishedGraph(db, run.workflowId);
  if (!graph?.nodes.some((n) => n.id === nodeId)) throw new DirectoryError("No such step");
  await addEvent(db, run.id, run.nodeId, "move", { data: { from: run.nodeId, to: nodeId, personId } });
  await enter(db, run, nodeId, notify, undefined, false);
}
