import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { workflowRunEvents, workflowRuns } from "../db/schema.js";
import { DirectoryError } from "../org/directory.js";

export type TracePath = { runId: string; title: string; status: string; steps: { nodeId: string; at: string; result: string | null; reason: string | null }[] };

/** Events in time order; at a tie a result comes first, as step() writes result(prev) then step(next) in one transaction. */
export const inOrder = <T extends { at: Date; kind: string }>(events: T[]): T[] => {
  const rank = (k: string) => (k === "result" ? 0 : 1);
  return [...events].sort((a, b) => a.at.getTime() - b.at.getTime() || rank(a.kind) - rank(b.kind));
};

/** The steps a run entered, in order, each visit with the result it ended on (null while still there, or when a person moved it off). */
export async function tracePath(db: Db, tenantId: string, runId: string): Promise<TracePath> {
  const [run] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.tenantId, tenantId)));
  if (!run) throw new DirectoryError("No such run");
  const events = inOrder(await db.select().from(workflowRunEvents).where(eq(workflowRunEvents.runId, runId)));
  const steps: TracePath["steps"] = [];
  let open: TracePath["steps"][number] | undefined; // the visit the run is on now
  for (const e of events) {
    if (e.kind === "step" || e.kind === "wait" || e.kind === "ask") {
      open = { nodeId: e.nodeId, at: e.at.toISOString(), result: null, reason: null };
      steps.push(open);
    } else if (e.kind === "result" && open && open.nodeId === e.nodeId) {
      open.result = e.result;
      open.reason = e.reason;
      open = undefined;
    } else if (e.kind === "move" || e.kind === "needs_person") {
      if (open) open.reason = e.reason;
      open = undefined;
    }
  }
  return { runId, title: run.title, status: run.status, steps };
}
