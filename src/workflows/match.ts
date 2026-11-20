import { and, desc, eq, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { workflowPending, workflowRuns, workflows } from "../db/schema.js";
import type { Workflow } from "../db/schema.js";
import { deliverEvent, emailAddress, emailDomain, reopenRun, startRun } from "./runs.js";
import type { Notify, RunEvent } from "./runs.js";

export type Match = { kind: "wake"; runId: string } | { kind: "ask"; runId: string; why: "domain" | "ended" } | { kind: "new" };
export type EmailEvent = Extract<RunEvent, { type: "email" }>;

const FREE_MAIL = new Set(["gmail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "me.com", "bigpond.com", "bigpond.net.au", "optusnet.com.au", "proton.me", "protonmail.com"]);
const has = (key: "threadIds" | "emails", value: string) => sql`${workflowRuns.keys}->${key} @> ${JSON.stringify([value])}::jsonb`;

/** Which run an email belongs to: a thread or sender on an open run wakes it; a shared company domain or an ended run asks a person. */
export async function matchEmail(db: Db, workflowId: string, mail: { threadId: string | null; from: string }): Promise<Match> {
  const from = emailAddress(mail.from);
  const domain = emailDomain(from);
  const free = FREE_MAIL.has(domain);
  const runs = await db
    .select({ id: workflowRuns.id, status: workflowRuns.status, keys: workflowRuns.keys })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.workflowId, workflowId), or(mail.threadId ? has("threadIds", mail.threadId) : undefined, has("emails", from), free ? undefined : sql`${workflowRuns.keys}->>'domain' = ${domain}`)))
    .orderBy(desc(workflowRuns.updatedAt));
  const ended = (r: (typeof runs)[number]) => r.status === "done" || r.status === "failed";
  const byThread = (r: (typeof runs)[number]) => !!mail.threadId && r.keys.threadIds.includes(mail.threadId);
  const bySender = (r: (typeof runs)[number]) => r.keys.emails.includes(from);
  const open = runs.filter((r) => !ended(r));
  const wake = open.find(byThread) ?? open.find(bySender);
  if (wake) return { kind: "wake", runId: wake.id };
  const sameDomain = free ? undefined : open.find((r) => r.keys.domain === domain);
  if (sameDomain) return { kind: "ask", runId: sameDomain.id, why: "domain" };
  const old = runs.filter(ended).find((r) => byThread(r) || bySender(r));
  return old ? { kind: "ask", runId: old.id, why: "ended" } : { kind: "new" };
}

/** A new run for an email, titled `<subject> (<sender>)`. */
export function startFromEmail(db: Db, wf: Workflow, e: EmailEvent, notify: Notify) {
  const from = emailAddress(e.from);
  const keys = { threadIds: e.threadId ? [e.threadId] : [], emails: [from], domain: emailDomain(from) };
  return startRun(db, wf, { title: `${e.subject} (${e.from})`, keys, event: e }, notify);
}

/** Acts on a person's answer to an email-match question; the caller has already won the pending row. */
export async function resolveMatch(db: Db, pendingId: string, choice: string, notify: Notify): Promise<void> {
  const [row] = await db
    .select({ runId: workflowPending.runId, input: workflowPending.input, wf: workflows })
    .from(workflowPending)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowPending.runId))
    .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
    .where(and(eq(workflowPending.id, pendingId), eq(workflowPending.kind, "match")));
  if (!row) return;
  const event = row.input as EmailEvent;
  if (choice === "Reopen" && (await reopenRun(db, row.runId, event, notify))) return;
  // Attach, or Reopen of a run that is open again: deliver; a run that ended meanwhile gets a new one instead
  if (choice !== "Start new" && (await deliverEvent(db, row.runId, event, notify))) return;
  await startFromEmail(db, row.wf, event, notify);
}
