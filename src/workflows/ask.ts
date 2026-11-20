import { and, eq, inArray } from "drizzle-orm";
import { confirmerPolicy } from "../admin/access.js";
import type { Db } from "../db/client.js";
import { workflowPending, workflowRuns, workflows } from "../db/schema.js";
import type { WorkflowRun } from "../db/schema.js";
import { card } from "../teams/cards.js";
import type { AdaptiveCard } from "../teams/cards.js";
import type { AskNode } from "./graph.js";
import { resolveMatch } from "./match.js";
import { takeExit } from "./runs.js";
import type { Notify } from "./runs.js";

const CLOSED = "This question has closed.";

/** The question as a card: one button per choice, answered through the `wfask` verb. */
export const askCard = (pendingId: string, title: string, question: string, choices: string[]): AdaptiveCard =>
  card(
    [
      { type: "TextBlock", text: title, weight: "Bolder", wrap: true },
      { type: "TextBlock", text: question, wrap: true },
    ],
    choices.map((choice) => ({ type: "Action.Execute", title: choice, verb: "wfask", data: { pendingId, choice } })),
  );

/** Stores the question and posts it to the workflow's chat; if the post fails the run keeps waiting and the chat is told in text. */
export async function postAsk(db: Db, send: (chatId: string, m: string | AdaptiveCard) => Promise<void>, run: WorkflowRun, node: AskNode): Promise<void> {
  const [wf] = await db.select({ chatId: workflows.chatId }).from(workflows).where(eq(workflows.id, run.workflowId));
  if (!wf) return;
  const id = crypto.randomUUID();
  await db.insert(workflowPending).values({ id, runId: run.id, nodeId: node.id, kind: "ask", choices: node.choices, askPersonId: node.personId ?? null });
  try {
    await send(wf.chatId, askCard(id, run.title, node.question, node.choices));
  } catch (err) {
    console.error(`workflow run ${run.id}: posting the question failed`, err);
    await send(wf.chatId, `Couldn't post the question for ${run.title}: ${node.question}`).catch(() => {});
  }
}

/** A click on an ask card; returns the text the card shows. */
export async function answerAsk(db: Db, pendingId: string, personId: string, personName: string, choice: string, notify: Notify): Promise<string> {
  const [row] = await db
    .select({ p: workflowPending, tenantId: workflows.tenantId, definitionId: workflows.definitionId, runAsPersonId: workflows.runAsPersonId, chatId: workflows.chatId })
    .from(workflowPending)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowPending.runId))
    .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
    .where(and(eq(workflowPending.id, pendingId), inArray(workflowPending.kind, ["ask", "match"])));
  if (!row || row.p.status !== "pending") return CLOSED;
  if (!row.p.choices?.includes(choice)) return "That isn't one of the choices.";
  const allowed = row.p.askPersonId
    ? row.p.askPersonId === personId
    : await confirmerPolicy(db, row.tenantId, row.definitionId, row.runAsPersonId, "write", row.chatId)(personId).catch(() => false);
  if (!allowed) return "You can't answer this question.";
  // the guarded update is the lock on the row: one click wins
  const win = async () =>
    (await db
      .update(workflowPending)
      .set({ status: "answered", answeredByPersonId: personId, answer: choice })
      .where(and(eq(workflowPending.id, pendingId), eq(workflowPending.status, "pending")))
      .returning({ id: workflowPending.id })).length > 0;
  // an email-match question is about where an email goes, not the run's current node
  if (row.p.kind === "match") {
    if (!(await win())) return CLOSED;
    await resolveMatch(db, pendingId, choice, notify);
    return `${choice}, by ${personName}`;
  }
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, row.p.runId));
  const close = async () => {
    await db.update(workflowPending).set({ status: "cancelled" }).where(and(eq(workflowPending.id, pendingId), eq(workflowPending.status, "pending")));
    return CLOSED;
  };
  if (!run || run.status !== "waiting" || run.nodeId !== row.p.nodeId) return close();
  if (!(await win())) return CLOSED;
  // takeExit moves nothing if the run moved meanwhile (a reply, the timeout, a loop back to this ask)
  if (!(await takeExit(db, run, choice, notify, undefined, undefined, true))) {
    await db.update(workflowPending).set({ status: "cancelled" }).where(eq(workflowPending.id, pendingId));
    return CLOSED;
  }
  return `${choice}, by ${personName}`;
}
