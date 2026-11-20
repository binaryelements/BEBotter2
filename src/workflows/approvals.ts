import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { confirmerPolicy } from "../admin/access.js";
import type { Db } from "../db/client.js";
import { people, workflowPending, workflowRuns, workflows } from "../db/schema.js";
import type { WorkflowTurn } from "../engine/runner.js";

type Answer = "confirmed" | "denied" | "not_allowed" | "unknown";

const sorted = (_k: string, v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v;

/** The fingerprint of one call: an approval allows exactly this tool with exactly these arguments. */
export const inputHash = (toolName: string, input: Record<string, unknown>): string =>
  createHash("sha256").update(JSON.stringify([toolName, input], sorted)).digest("hex");

/** Stores a write a workflow step wants to make; its id is the card's actionId. */
export async function holdForApproval(db: Db, run: { id: string; nodeId: string }, toolName: string, input: Record<string, unknown>): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(workflowPending).values({ id, runId: run.id, nodeId: run.nodeId, kind: "approval", toolName, input, inputHash: inputHash(toolName, input) });
  return id;
}

/** A click on a held approval. Only a `pending` row resolves; the run waiting on it is readied so the ticker re-runs the step. */
export async function resolveApproval(db: Db, pendingId: string, personId: string, answer: "yes" | "no", mayConfirm: (p: string) => Promise<boolean>): Promise<Answer> {
  const [seen] = await db.select().from(workflowPending).where(and(eq(workflowPending.id, pendingId), eq(workflowPending.kind, "approval")));
  if (seen?.status !== "pending") return "unknown";
  if (!(await mayConfirm(personId).catch(() => false))) return "not_allowed";
  let out: Answer = "unknown";
  await db.transaction(async (tx) => {
    // the run first, as deliverEvent locks it, so the two never deadlock
    const [run] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, seen.runId)).for("update");
    const [row] = await tx.select().from(workflowPending).where(eq(workflowPending.id, pendingId)).for("update");
    if (!run || row?.status !== "pending") return; // cancelled by a reply, or answered, while the policy was checked
    await tx.update(workflowPending).set({ status: answer === "yes" ? "approved" : "declined", answeredByPersonId: personId }).where(eq(workflowPending.id, pendingId));
    // a step still running (a quick click) is readied by runAiStep when its turn ends
    if (run.status === "waiting" && run.nodeId === row.nodeId)
      await tx.update(workflowRuns).set({ status: "ready", updatedAt: new Date() }).where(eq(workflowRuns.id, run.id));
    out = answer === "yes" ? "confirmed" : "denied";
  });
  return out;
}

/** A card click that the in-memory confirmations don't know: a workflow approval, checked with the workflow's own confirmers. */
export async function clickApproval(db: Db, pendingId: string, personId: string, answer: "yes" | "no"): Promise<Answer> {
  const [wf] = await db
    .select({ tenantId: workflows.tenantId, definitionId: workflows.definitionId, runAsPersonId: workflows.runAsPersonId, chatId: workflows.chatId })
    .from(workflowPending)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowPending.runId))
    .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
    .where(and(eq(workflowPending.id, pendingId), eq(workflowPending.kind, "approval")));
  if (!wf) return "unknown";
  return resolveApproval(db, pendingId, personId, answer, confirmerPolicy(db, wf.tenantId, wf.definitionId, wf.runAsPersonId, "write", wf.chatId));
}

/** The step's newest approval decision not yet used, marked used so it applies to one run of the step. */
export async function latestDecision(db: Db, runId: string, nodeId: string): Promise<{ approved?: WorkflowTurn["approved"]; line?: string }> {
  const used = await db
    .update(workflowPending)
    .set({ answer: "used" })
    .where(and(eq(workflowPending.runId, runId), eq(workflowPending.nodeId, nodeId), eq(workflowPending.kind, "approval"), inArray(workflowPending.status, ["approved", "declined"]), isNull(workflowPending.answer)))
    .returning();
  const [d] = used.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  if (!d?.answeredByPersonId) return {};
  const [who] = await db.select({ name: people.name }).from(people).where(eq(people.id, d.answeredByPersonId));
  const name = who?.name ?? "a person";
  if (d.status === "declined") return { line: `Declined by ${name}.` };
  return {
    approved: { pendingId: d.id, toolName: d.toolName!, inputHash: d.inputHash!, personId: d.answeredByPersonId },
    line: `Approved by ${name}: make exactly the call you asked for, then report.`,
  };
}
