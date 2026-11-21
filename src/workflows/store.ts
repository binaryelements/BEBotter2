import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { botDefinitions, chatAssignments, chats as chatsT, people, workflowRunEvents, workflowRuns, workflows, workflowVersions } from "../db/schema.js";
import type { Workflow } from "../db/schema.js";
import type { Db } from "../db/client.js";
import { DirectoryError } from "../org/directory.js";
import { getTenantSettings } from "../org/org.js";
import { checkGraph, NEEDS_PERSON, parseGraph } from "./graph.js";
import type { WorkflowGraph } from "./graph.js";
import { waitUntil } from "./hours.js";
import { nodeEntry } from "./runs.js";

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

export const draftHash = (graph: WorkflowGraph) => createHash("sha256").update(JSON.stringify(graph)).digest("hex");

/** Thrown when a save was made against a draft that has since changed. */
export class StaleDraft extends Error {
  constructor() {
    super("This workflow was changed somewhere else. Reload to see the latest.");
  }
}

/** Saves the draft and returns its hash. With `base` (the hash the editor loaded) the save is refused if the draft has changed since. */
export async function saveDraft(db: Db, tenantId: string, workflowId: string, graph: unknown, base?: string): Promise<string> {
  const draft = parseGraph(graph);
  return db.transaction(async (tx) => {
    const [w] = await tx.select({ draft: workflows.draft }).from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.tenantId, tenantId))).for("update");
    if (!w) throw new DirectoryError("No such workflow");
    if (base !== undefined && base !== draftHash(w.draft)) throw new StaleDraft();
    // hash what the database stores: jsonb reorders keys, so the input's own order would never match a later load
    const [saved] = await tx.update(workflows).set({ draft }).where(eq(workflows.id, workflowId)).returning({ draft: workflows.draft });
    return draftHash(saved.draft);
  });
}

/** Replaces the draft under a row lock; with `base`, refused if the draft changed since. Returns the new base. */
const setDraft = (db: Db, tenantId: string, workflowId: string, base: string | undefined, draft: (published: WorkflowGraph | undefined, tx: Pick<Db, "select">) => Promise<WorkflowGraph | undefined> | WorkflowGraph | undefined) =>
  db.transaction(async (tx) => {
    const [w] = await tx.select().from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.tenantId, tenantId))).for("update");
    if (!w) throw new DirectoryError("No such workflow");
    if (base !== undefined && base !== draftHash(w.draft)) throw new StaleDraft();
    const graph = await draft(await graphOf(tx, workflowId, w.publishedVersion), tx);
    if (!graph) throw new DirectoryError("No such version");
    const [saved] = await tx.update(workflows).set({ draft: graph }).where(eq(workflows.id, workflowId)).returning({ draft: workflows.draft });
    return draftHash(saved.draft);
  });

/** Throws away the draft's changes: it becomes the published graph, or empty if never published. */
export const discardDraft = (db: Db, tenantId: string, workflowId: string, base?: string) => setDraft(db, tenantId, workflowId, base, (published) => published ?? emptyGraph());

export async function listVersions(db: Db, tenantId: string, workflowId: string): Promise<{ version: number; publishedAt: Date; publishedBy: string; live: boolean }[]> {
  const [w] = await db.select().from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.tenantId, tenantId)));
  if (!w) throw new DirectoryError("No such workflow");
  const rows = await db
    .select({ version: workflowVersions.version, publishedAt: workflowVersions.publishedAt, publishedBy: people.name })
    .from(workflowVersions)
    .innerJoin(people, eq(people.id, workflowVersions.publishedByPersonId))
    .where(eq(workflowVersions.workflowId, workflowId))
    .orderBy(desc(workflowVersions.version));
  return rows.map((r) => ({ ...r, live: r.version === w.publishedVersion }));
}

/** Copies a published version into the draft; it goes live only when published again. */
export async function restoreVersion(db: Db, tenantId: string, workflowId: string, version: number, base?: string): Promise<string> {
  return setDraft(db, tenantId, workflowId, base, async (_published, tx) => {
    const [v] = await tx.select({ graph: workflowVersions.graph }).from(workflowVersions).where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.version, version)));
    return v?.graph;
  });
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

export async function publish(db: Db, tenantId: string, workflowId: string, personId: string, moves: Moves, base?: string): Promise<number> {
  return db.transaction(async (tx) => {
    const [w] = await tx.select().from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.tenantId, tenantId))).for("update");
    if (!w) throw new DirectoryError("No such workflow");
    if (base !== undefined && base !== draftHash(w.draft)) throw new StaleDraft();
    const draft = w.draft;
    const problems = checkGraph(draft);
    if (problems.length > 0) throw new DirectoryError(problems.join("; "));
    const askPeople = draft.nodes.flatMap((n) => (n.type === "ask" && n.personId ? [n] : []));
    if (askPeople.length) {
      const known = await tx.select({ id: people.id }).from(people).where(and(eq(people.tenantId, tenantId), eq(people.licensed, true), inArray(people.id, askPeople.map((n) => n.personId!))));
      const ids = new Set(known.map((p) => p.id));
      for (const n of askPeople) if (!ids.has(n.personId!)) throw new DirectoryError(`"${n.label}" asks someone who isn't in this company`);
    }
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
      if (draft.nodes.find((n) => n.id === to)?.type === "trigger") throw new DirectoryError("Runs can't be moved onto the trigger");
    }
    const now = new Date();
    const tz = (await getTenantSettings(tx as unknown as Db, tenantId)).timezone;
    for (const r of stranded) {
      const to = moves[r.nodeId];
      const target = draft.nodes.find((n) => n.id === to);
      // shortcut: publish can't post Ask cards, so a run moved onto an Ask step waits for a person; post the card from publish when the canvas API exists
      const parked = !target || target.type === "ask";
      await tx
        .update(workflowRuns)
        .set(parked ? { status: "needs_person", dueAt: null, updatedAt: now } : { ...nodeEntry(target, now, tz, draft.holidays), nodeId: to, updatedAt: now })
        .where(eq(workflowRuns.id, r.id));
      const reason = target?.type === "ask" ? "moved onto an Ask step" : undefined;
      await tx.insert(workflowRunEvents).values({ id: crypto.randomUUID(), runId: r.id, nodeId: r.nodeId, kind: "move", reason, data: { from: r.nodeId, to } });
    }
    // Waits whose length changed get a new due time, counted from when they started.
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
    // A workflow answers the mail now, so the bot must not also act on it.
    if (hasEmailTrigger(draft)) await tx.update(botDefinitions).set({ mailMode: "notify" }).where(eq(botDefinitions.id, w.definitionId));
    return version;
  });
}

export async function emailWorkflowFor(db: Db, definitionId: string): Promise<Workflow | undefined> {
  for (const w of await db.select().from(workflows).where(eq(workflows.definitionId, definitionId))) {
    if (hasEmailTrigger(await graphOf(db, w.id, w.publishedVersion))) return w;
  }
}
