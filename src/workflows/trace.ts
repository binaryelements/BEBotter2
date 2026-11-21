import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { workflowRunEvents, workflowRuns } from "../db/schema.js";
import { DirectoryError } from "../org/directory.js";

export type TracePath = { runId: string; title: string; status: string; steps: { nodeId: string; at: string; result: string | null; reason: string | null }[] };

/** The steps a run entered, in order, each with the result it ended on (null while still there). */
export async function tracePath(db: Db, tenantId: string, runId: string): Promise<TracePath> {
  const [run] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.tenantId, tenantId)));
  if (!run) throw new DirectoryError("No such run");
  const events = await db.select().from(workflowRunEvents).where(eq(workflowRunEvents.runId, runId)).orderBy(asc(workflowRunEvents.at));
  const steps: TracePath["steps"] = [];
  events.forEach((e, i) => {
    if (e.kind !== "step" && e.kind !== "wait" && e.kind !== "ask") return;
    const r = events.slice(i + 1).find((x) => x.kind === "result" && x.nodeId === e.nodeId);
    steps.push({ nodeId: e.nodeId, at: e.at.toISOString(), result: r?.result ?? null, reason: r?.reason ?? null });
  });
  return { runId, title: run.title, status: run.status, steps };
}
