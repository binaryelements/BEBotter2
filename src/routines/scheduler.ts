import { and, eq } from "drizzle-orm";
import { beginAction, completeAction, recordSent } from "../audit/audit.js";
import { mayUseDefinition } from "../admin/access.js";
import { definitionsForChat, getDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { chats, people } from "../db/schema.js";
import type { Routine } from "../db/schema.js";
import type { RunResult, RunTurnInput } from "../engine/runner.js";
import { confirmationCard, withRoleLabel } from "../teams/cards.js";
import type { AdaptiveCard } from "../teams/cards.js";
import { logTurn, serialize } from "../teams/handlers.js";
import { claimDue } from "./store.js";

export type SchedulerDeps = {
  db: Db;
  runTurn: (turn: RunTurnInput) => Promise<RunResult>;
  send: (chatId: string, m: string | AdaptiveCard) => Promise<void>;
  /** The owner's Graph token for a one-to-one chat, outside any turn; a personal bot's routine needs it. */
  personToken?: (chatId: string) => Promise<string | undefined>;
};

/** Runs one claimed routine headless and posts to its chat. A run that cannot happen is audited as failed, never thrown. */
export async function runRoutine(deps: SchedulerDeps, routine: Routine): Promise<void> {
  const { db } = deps;
  const { tenantId, chatId, definitionId } = routine;
  const due = new Date(); // shortcut: claim time stands in for the scheduled time, which claimDue does not return
  const fail = async (reason: string) => {
    console.error(`routine ${routine.id}: ${reason}`);
    try {
      const id = await beginAction(db, { tenantId, chatId, definitionId, personId: routine.createdByPersonId, kind: "message", summary: `Routine not run: ${reason}` });
      await completeAction(db, id, { status: "failed" });
    } catch (err) {
      console.error(`routine ${routine.id}: audit failed`, err);
    }
  };

  const definition = await getDefinition(db, tenantId, definitionId);
  if (!definition) return fail("its bot no longer exists");
  const [chat] = await db.select().from(chats).where(and(eq(chats.id, chatId), eq(chats.tenantId, tenantId)));
  if (!chat) return fail("its chat no longer exists");
  if (!(await definitionsForChat(db, chatId)).some((d) => d.id === definitionId)) return fail("its bot is no longer in its chat");
  if (!chat.conversationReference) return fail("its chat cannot be reached yet");
  const [creator] = await db.select().from(people).where(and(eq(people.id, routine.createdByPersonId), eq(people.tenantId, tenantId)));
  if (!creator) return fail("its creator no longer exists");
  if (!(await mayUseDefinition(db, tenantId, creator.id, definitionId))) return fail("its creator no longer has access to this bot");
  // the grant holds only while its holder is still an admin; otherwise writes wait for a card like any other
  const [granter] = routine.grantPersonId
    ? await db.select({ role: people.role }).from(people).where(and(eq(people.id, routine.grantPersonId), eq(people.tenantId, tenantId)))
    : [];
  const grantPersonId = granter?.role === "admin" ? routine.grantPersonId : null;

  const post = (text: string) => deps.send(chatId, chat.conversationType === "personal" ? text : withRoleLabel(definition.label, text));
  let graphToken: (() => Promise<string | undefined>) | undefined;
  if (definition.identity === "person") {
    if (chat.conversationType !== "personal" || chat.ownerPersonId !== creator.id) return fail("its bot is private to its owner");
    const { personToken } = deps;
    graphToken = personToken && (() => personToken(chatId));
    const signedIn = await graphToken?.().then((t) => !!t, (e) => void console.error(`routine ${routine.id}: token`, e instanceof Error ? e.name : "error"));
    if (!signedIn) {
      await post("Sign in again to let me run this routine.").catch(() => {});
      return fail("its owner is not signed in");
    }
  }
  // a background job queues on its own, so the chat's messages are not held behind it
  await serialize(routine.background ? `${chatId}:${definitionId}:${routine.id}` : `${chatId}:${definitionId}`, async () => {
    let result: RunResult;
    try {
      result = await deps.runTurn({
        tenantId,
        chatId,
        definition,
        person: creator,
        text: routine.prompt,
        receivedAt: due,
        askConfirmation: (req) => deps.send(chatId, confirmationCard(req)),
        routine: { id: routine.id, grantPersonId, post, background: routine.background },
        ...(graphToken ? { graphToken } : {}),
      });
    } catch (err) {
      console.error(err);
      return fail("the run failed");
    }
    // a quiet routine still says what it changed under its grant (spec 4.6)
    if (routine.quiet && !result.changed) return;
    try {
      await post(result.text);
    } catch (err) {
      console.error(err);
      return fail("its reply could not be posted");
    }
    try {
      await recordSent(db, result.auditId, new Date());
    } catch (err) {
      console.error("recording turn timing failed", err); // the reply is already posted
    }
    logTurn(chatId, result.timings);
  });
}

/**
 * Every intervalMs claims due routines and runs them side by side (each serialised with its own chat), so a slow
 * run or an unanswered card holds back no other routine. Errors are logged and never stop the loop. Returns a stop function.
 * The interval is well under a minute so timer drift never skips a cron minute; claimDue runs each at most once a minute.
 */
export function startScheduler(deps: SchedulerDeps, intervalMs = 20_000, now = () => new Date()): () => void {
  const tick = async () => {
    try {
      const claimed = await claimDue(deps.db, now());
      await Promise.allSettled(
        claimed.map((routine) => runRoutine(deps, routine).catch((err) => console.error(`routine ${routine.id} failed`, err))),
      );
    } catch (err) {
      console.error("scheduler tick failed", err);
    }
  };
  // ticks may overlap: a cron routine is due only in its own minute, claimDue hands each run to one tick, and serialize orders turns per chat
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  console.log("scheduler started");
  return () => clearInterval(timer);
}
