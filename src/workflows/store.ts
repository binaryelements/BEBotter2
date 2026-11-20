import { and, eq, notInArray } from "drizzle-orm";
import { botDefinitions, chatAssignments, chats as chatsT, workflowRunEvents, workflowRuns, workflows, workflowVersions } from "../db/schema.js";
import type { Workflow } from "../db/schema.js";
import type { Db } from "../db/client.js";
import { DirectoryError } from "../org/directory.js";
import { getTenantSettings } from "../org/org.js";
import { checkGraph, NEEDS_PERSON, parseGraph } from "./graph.js";
import type { WorkflowGraph } from "./graph.js";
import { waitUntil } from "./hours.js";

export type Moves = Record<string, string>; // removed node id -> node id in the new version, or "needs_person"

const CLOSED = ["done", "failed"];
const emptyGraph = (): WorkflowGraph => ({ nodes: [], edges: [], holidays: [] });

export async function createWorkflow(
  db: Db,
  tenantId: string,
  input: { definitionId: string; name: string; chatId: string; runAsPersonId: string },
): Promise<Workflow> {
  const [def] = await db.select({ identity: botDefinitions.identity }).from(botDefinitions).where(and(eq(botDefinitions.id, input.definitionId), eq(botDefinitions.tenantId, tenantId)));
  if (!def) throw new DirectoryError("No such bot");
  if (def.identity === "person") throw new DirectoryError("A bot that acts as a person cannot have workflows");
  const [assigned] = await db
    .select({ chatId: chatAssignments.chatId })
    .from(chatAssignments)
    .innerJoin(chatsT, eq(chatsT.id, chatAssignments.chatId))
    .where(and(eq(chatAssignments.chatId, input.chatId), eq(chatAssignments.definitionId, input.definitionId), eq(chatsT.tenantId, tenantId)));
  if (!assigned) throw new DirectoryError("That bot is not assigned to this chat");
  const [row] = await db.insert(workflows).values({ id: crypto.randomUUID(), tenantId, ...input, draft: emptyGraph() }).returning();
  return row;
}

export async function saveDraft(db: Db, tenantId: string, workflowId: string, graph: unknown): Promise<void> {
  const draft = parseGraph(graph);
  const rows = await db.update(workflows).set({ draft }).where(and(eq(workflows.id, workflowId), eq(workflows.tenantId, tenantId))).returning({ id: workflows.id });
  if (rows.length === 0) throw new DirectoryError("No such workflow");
}

async function graphOf(db: Pick<Db, "select">, workflowId: string, version: number | null): Promise<WorkflowGraph | undefined> {
  if (version === null) return undefined;
  const [v] = await db.select({ graph: workflowVersions.graph }).from(workflowVersions).where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.version, version)));
  return v?.graph;
}

export async function publishedGraph(db: Db, workflowId: string): Promise<WorkflowGraph | undefined> {
  const [w] = await db.select({ v: workflows.publishedVersion }).from(workflows).where(eq(workflows.id, workflowId));
  return w ? graphOf(db, workflowId, w.v) : undefined;
}

/** Open runs whose node is not in the draft; needs_person runs are parked and a person moves them later. */
async function strandedRuns(db: Pick<Db, "select">, tenantId: string, w: Workflow) {
  const kept = new Set(w.draft.nodes.map((n) => n.id));
  const runs = await db
    .select({ id: workflowRuns.id, nodeId: workflowRuns.nodeId })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.workflowId, w.id), eq(workflowRuns.tenantId, tenantId), notInArray(workflowRuns.status, [...CLOSED, "needs_person"])));
  return runs.filter((r) => !kept.has(r.nodeId));
}

export async function runsOnRemovedNodes(db: Db, tenantId: string, workflowId: string): Promise<{ nodeId: string; runIds: string[] }[]> {
  const [w] = await db.select().from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.tenantId, tenantId)));
  if (!w) throw new DirectoryError("No such workflow");
  const byNode = new Map<string, string[]>();
  for (const r of await strandedRuns(db, tenantId, w)) byNode.set(r.nodeId, [...(byNode.get(r.nodeId) ?? []), r.id]);
  return [...byNode].map(([nodeId, runIds]) => ({ nodeId, runIds }));
}

const hasEmailTrigger = (g: WorkflowGraph | undefined) => !!g?.nodes.some((n) => n.type === "trigger" && n.trigger === "email");

export async function publish(db: Db, tenantId: string, workflowId: string, personId: string, moves: Moves): Promise<number> {
  return db.transaction(async (tx) => {
    const [w] = await tx.select().from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.tenantId, tenantId)));
    if (!w) throw new DirectoryError("No such workflow");
    const draft = w.draft;
    const problems = checkGraph(draft);
    if (problems.length > 0) throw new DirectoryError(problems.join("; "));
    if (hasEmailTrigger(draft)) {
      const others = await tx.select().from(workflows).where(and(eq(workflows.definitionId, w.definitionId), eq(workflows.tenantId, tenantId)));
      for (const o of others) {
        if (o.id !== w.id && hasEmailTrigger(await graphOf(tx, o.id, o.publishedVersion))) throw new DirectoryError("This bot already has a workflow that starts on email");
      }
    }
    const prev = await graphOf(tx, workflowId, w.publishedVersion);
    const draftIds = new Set(draft.nodes.map((n) => n.id));
    const stranded = await strandedRuns(tx, tenantId, w);
    for (const r of stranded) {
      const to = moves[r.nodeId];
      if (to === undefined || (to !== NEEDS_PERSON && !draftIds.has(to))) {
        const label = prev?.nodes.find((n) => n.id === r.nodeId)?.label ?? r.nodeId;
        throw new DirectoryError(`Choose where runs on ${label} go`);
      }
    }
    const now = new Date();
    for (const r of stranded) {
      const to = moves[r.nodeId];
      await tx
        .update(workflowRuns)
        .set(to === NEEDS_PERSON ? { status: "needs_person", dueAt: null, updatedAt: now } : { nodeId: to, status: "ready", dueAt: null, waitStartedAt: null, updatedAt: now })
        .where(eq(workflowRuns.id, r.id));
      await tx.insert(workflowRunEvents).values({ id: crypto.randomUUID(), runId: r.id, nodeId: r.nodeId, kind: "move", data: { from: r.nodeId, to } });
    }
    // Waits whose length changed get a new due time, counted from when they started.
    const tz = (await getTenantSettings(tx as unknown as Db, tenantId)).timezone;
    for (const n of draft.nodes) {
      const old = prev?.nodes.find((p) => p.id === n.id);
      if (n.type !== "wait" || old?.type !== "wait" || (old.minutes === n.minutes && old.businessHours === n.businessHours)) continue;
      const waiting = await tx
        .select({ id: workflowRuns.id, started: workflowRuns.waitStartedAt })
        .from(workflowRuns)
        .where(and(eq(workflowRuns.workflowId, workflowId), eq(workflowRuns.nodeId, n.id), eq(workflowRuns.status, "waiting")));
      for (const r of waiting) {
        if (r.started) await tx.update(workflowRuns).set({ dueAt: waitUntil(r.started, n.minutes, n.businessHours, tz, draft.holidays), updatedAt: now }).where(eq(workflowRuns.id, r.id));
      }
    }
    const version = (w.publishedVersion ?? 0) + 1;
    await tx.insert(workflowVersions).values({ workflowId, version, graph: draft, publishedByPersonId: personId });
    await tx.update(workflows).set({ publishedVersion: version }).where(eq(workflows.id, workflowId));
    return version;
  });
}

export async function emailWorkflowFor(db: Db, definitionId: string): Promise<Workflow | undefined> {
  for (const w of await db.select().from(workflows).where(eq(workflows.definitionId, definitionId))) {
    if (hasEmailTrigger(await graphOf(db, w.id, w.publishedVersion))) return w;
  }
}
