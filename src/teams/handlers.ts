import { recordSent } from "../audit/audit.js";
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditEvents, chats, people, sessions } from "../db/schema.js";
import type { TurnTimings } from "../db/schema.js";
import type { Confirmations } from "../engine/confirm.js";
import type { ProgressEvent, RunResult, RunTurnInput } from "../engine/runner.js";
import { assignToChat, definitionsForChat, listDefinitions, setChatDefinition, usableDefinitions } from "../bots/definitions.js";
import { isAdmin, loadActor, mayUseDefinition } from "../admin/access.js";
import { findPersonId, getTenantSettings, recordChatOwner, saveConversationReference, upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { botTitle, chooseBotCard, confirmationCard, resultCard, toolWords, withRoleLabel } from "./cards.js";
import { recordOverheard, takeOverheard, withOverheard } from "./overheard.js";
import { recentAttachments, storeAttachments, withAttachments } from "./attachments.js";
import type { IncomingAttachment } from "./attachments.js";
import type { AdaptiveCard } from "./cards.js";

export type IncomingMessage = {
  tenantId: string;
  chatId: string;
  conversationType: string;
  /** What Teams calls the chat, when it has a name (a group chat's topic). */
  name?: string;
  /** Group chats: the message @mentioned the bot. Without the permission to read every message, Teams only sends these. */
  mentioned?: boolean;
  /** Group chats: the message @mentioned someone other than the bot, so it is for them. */
  mentionedOthers?: boolean;
  from: { aadObjectId: string; name: string; /** the sender's Teams client time zone, e.g. Australia/Melbourne */ timezone?: string };
  text: string;
  /** Files and images on the message, fetched only once the bot keeps them. */
  attachments?: IncomingAttachment[];
  receivedAt?: Date;
  conversationReference: unknown;
};

// turns per chat and bot definition run one after another, so two never resume the same session at once
const chains = new Map<string, Promise<unknown>>();

/** Runs fn after every earlier fn with the same key has settled; key is `${chatId}:${definitionId}`. */
export async function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const turn = (chains.get(key) ?? Promise.resolve()).then(fn);
  const tail = turn.catch(() => {});
  chains.set(key, tail);
  try {
    return await turn;
  } finally {
    if (chains.get(key) === tail) chains.delete(key);
  }
}

type BurstJob = {
  queue: IncomingMessage[];
  running?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  wake?: () => void;
  draining?: boolean;
};
/** One job per person and bot: their messages coalesce, while different people still take turns one at a time. */
const burstJobs = new Map<string, BurstJob>();

function armQuiet(job: BurstJob, quietMs: number) {
  if (job.timer) clearTimeout(job.timer);
  if (quietMs <= 0) {
    // tests and an explicitly immediate setting: no timer at all, so fake timers cannot hold a turn
    queueMicrotask(() => {
      job.timer = undefined;
      const wake = job.wake;
      job.wake = undefined;
      wake?.();
    });
    return;
  }
  const timer = setTimeout(() => {
    job.timer = undefined;
    const wake = job.wake;
    job.wake = undefined;
    wake?.();
  }, quietMs);
  (timer as { unref?: () => void }).unref?.();
  job.timer = timer;
}

/**
 * Runs the person's messages as one burst. A message that arrives while the bot is answering stops that
 * answer; the next turn takes the running message and the new one together. Resolves when this call's
 * burst (and any that overtook it) has finished.
 */
export async function submitBurst(
  key: string,
  msg: IncomingMessage,
  quietMs: number,
  run: (batch: IncomingMessage[], signal: AbortSignal) => Promise<boolean>,
): Promise<void> {
  let job = burstJobs.get(key);
  if (!job) {
    job = { queue: [] };
    burstJobs.set(key, job);
  }
  job.queue.push(msg);
  if (job.running) {
    job.running.abort(); // the turn in flight stops; the drain loop takes its messages again with this one
    return;
  }
  if (job.draining) {
    armQuiet(job, quietMs); // still collecting: give the person another moment
    return;
  }
  job.draining = true;
  armQuiet(job, quietMs);
  await drainBurst(key, job, quietMs, run);
}

async function drainBurst(
  key: string,
  job: BurstJob,
  quietMs: number,
  run: (batch: IncomingMessage[], signal: AbortSignal) => Promise<boolean>,
): Promise<void> {
  try {
    while (true) {
      await new Promise<void>((resolve) => (job.wake = resolve));
      if (!job.queue.length) break;
      const batch = job.queue.splice(0);
      const controller = new AbortController();
      job.running = controller;
      let stopped = false;
      try {
        stopped = await run(batch, controller.signal);
      } catch (err) {
        console.error("turn burst failed", err);
      } finally {
        job.running = undefined;
      }
      // an overtaken turn starts over with everything it was given, plus whatever has arrived since
      if (stopped && job.queue.length) job.queue.unshift(...batch);
      if (!job.queue.length) break;
      armQuiet(job, quietMs);
    }
  } finally {
    if (job.timer) clearTimeout(job.timer);
    job.draining = false;
    burstJobs.delete(key);
  }
}

const ms = (from: string, to?: string) => (to ? Date.parse(to) - Date.parse(from) : "-");
export function logTurn(chatId: string, t: TurnTimings) {
  console.log(`turn ${chatId} ${Date.now() - Date.parse(t.receivedAt)}ms ready=${ms(t.receivedAt, t.engineReadyAt)}ms first=${ms(t.receivedAt, t.firstOutputAt)}ms deliver=${t.resultAt ? Date.now() - Date.parse(t.resultAt) : "-"}ms tools=${t.tools}`);
}

export type TeamsIo = {
  send: (text: string) => Promise<string | undefined>; // resolves to the activity id when there is one
  update: (activityId: string, text: string) => Promise<void>;
  sendCard: (card: AdaptiveCard) => Promise<void>;
  /** "… is typing": sent when the bot is about to answer, never for a message it only hears. */
  typing?: () => Promise<void>;
  /** A reply typed out as it is written (one-to-one chats); end's text is the whole final message. */
  stream?: TeamsStream;
  /** The sender's Graph token, asked for per call; present only on a turn that signed in. */
  graphToken?: () => Promise<string | undefined>;
  /** Signs the sender out of Graph, so their next message brings the sign-in card. */
  signOut?: () => Promise<void>;
};
/** end's card, when given, goes out with the final message; finalText may then be empty. */
export type TeamsStream = { informative(text: string): void; chunk(text: string): void; end(finalText: string, card?: AdaptiveCard): Promise<void> };

const STATUS_AFTER_MS = 3000;
const STATUS_EVERY_MS = 2000;
const SLOW_AFTER_MS = 45_000;
export const SLOW_NOTE = "_Still working on this one; it's taking a while. The answer will appear here._";

/**
 * One status message for a slow turn: shown after 3 s, edited at most every 2 s (latest wins), then turned into the reply.
 * While `onStream` takes the text (true), it is shown there instead of as a message.
 */
function statusMessage(io: TeamsIo, decorate: (text: string) => string = (t) => t, onStream: (text: string) => boolean = () => false) {
  let label = "";
  let sawText = false;
  let shown = "";
  let id: string | undefined;
  let done = false;
  let sentOnce = false; // at most one status message per turn, even when Teams gave no id to edit it by
  let superseded = false;
  let last = Date.now() + STATUS_AFTER_MS - STATUS_EVERY_MS; // the first attempt is due STATUS_AFTER_MS from now
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ops: Promise<unknown> = Promise.resolve();

  const flush = async () => {
    timer = undefined;
    if (done || !label || label === shown) return;
    last = Date.now();
    shown = label;
    if (onStream(decorate(label))) return;
    try {
      if (id) await io.update(id, decorate(label));
      else if (!sentOnce) {
        sentOnce = true;
        id = await io.send(decorate(label));
      }
    } catch (err) {
      console.error("status message failed", err);
    }
  };
  const progress = (e: ProgressEvent) => {
    if (e.kind === "text") {
      const line = e.text.replace(/\s+/g, " ").trim().slice(0, 200);
      if (!line) return;
      label = line;
      sawText = true;
    } else if (e.kind === "tool" && !sawText) label = `Working: ${toolWords(e.toolName)}…`;
    else return;
    if (!timer && !done) timer = setTimeout(() => void (ops = ops.then(flush)), Math.max(0, last + STATUS_EVERY_MS - Date.now()));
  };
  /** No more status updates; waits for the one in flight. */
  const stop = async () => {
    done = true;
    clearTimeout(timer);
    await ops;
  };
  /** Replaces the status message with text; sends a new message when there is none, it cannot be edited, or a card was sent. */
  const finish = async (text: string) => {
    await stop();
    if (id && !superseded) {
      try {
        return await io.update(id, text);
      } catch (err) {
        console.error("status message update failed", err);
      }
    }
    id = await io.send(text);
  };
  /** A confirmation card went out: the reply must arrive as a new message, since edits notify nobody. */
  const supersede = () => {
    superseded = true;
  };
  return { progress, stop, finish, supersede };
}

const ownerOf = async (db: Db, chatId: string) => (await db.select({ owner: chats.ownerPersonId }).from(chats).where(eq(chats.id, chatId)))[0]?.owner;

export type HandlerDeps = {
  db: Db;
  runTurn: (turn: RunTurnInput) => Promise<RunResult>;
  botName: string;
  defaultModel: string;
  confirmations?: Confirmations;
  /** Wait this long after a message for the person to finish typing; a later one stops the reply and is taken with it. */
  burstQuietMs?: number;
  /** Posts to another chat: a personal assistant asked in a group answers in its owner's own one-to-one chat. */
  sendTo?: (chatId: string, message: string | AdaptiveCard) => Promise<void>;
  /** That chat owner's Graph token, outside the current turn. */
  personTokenFor?: (chatId: string) => Promise<string | undefined>;
};

export const signInFailed = "Sign-in didn't work. Say anything to try again.";

/** Whether this message will run its sender's own Personal, so the turn must sign in first; read-only, mirrors handleMessage's choice. */
export async function needsSignIn(
  deps: Pick<HandlerDeps, "db" | "defaultModel">,
  m: { tenantId: string; chatId: string; conversationType: string; aadObjectId: string; text: string },
): Promise<boolean> {
  const { db } = deps;
  if (m.conversationType !== "personal" || m.text.trim().toLowerCase() === "switch") return false;
  const personId = await findPersonId(db, m.tenantId, m.aadObjectId);
  if (!personId) return false;
  const owner = await ownerOf(db, m.chatId);
  if (owner && owner !== personId) return false;
  const usable = await usableDefinitions(db, m.tenantId, personId, deps.defaultModel);
  const [assigned] = await definitionsForChat(db, m.chatId);
  const definition = usable.find((d) => addressedByName(m.text, d)) ?? assigned ?? (usable.length === 1 ? usable[0] : undefined);
  return definition?.identity === "person" && usable.some((d) => d.id === definition.id);
}

export async function handleMessage(
  deps: HandlerDeps,
  msg: IncomingMessage,
  io: TeamsIo,
): Promise<void> {
  const { db } = deps;
  await upsertTenant(db, { id: msg.tenantId });
  const person = await upsertPerson(db, { tenantId: msg.tenantId, aadObjectId: msg.from.aadObjectId, name: msg.from.name, ...(msg.from.timezone ? { timezone: msg.from.timezone } : {}) });
  await upsertChat(db, { id: msg.chatId, tenantId: msg.tenantId, conversationType: msg.conversationType, ...(msg.name ? { name: msg.name } : {}) });
  await saveConversationReference(db, msg.chatId, msg.conversationReference);
  // a personal assistant named in a group chat does the work as its owner, and answers only in their own chat
  if (msg.conversationType !== "personal" && deps.sendTo) {
    const mine = await personalAssistantNamed(db, msg, person.id);
    if (mine) {
      const [own] = await db
        .select({ id: chats.id, reference: chats.conversationReference })
        .from(chats)
        .where(and(eq(chats.tenantId, msg.tenantId), eq(chats.conversationType, "personal"), eq(chats.ownerPersonId, person.id), isNotNull(chats.conversationReference)))
        .limit(1);
      if (!own?.reference) return void (await io.send("Message me in a one-to-one chat once, and I can do that for you privately from any chat."));
      const sendTo = deps.sendTo;
      const privateIo: TeamsIo = {
        send: async (text) => void (await sendTo(own.id, text)),
        update: async () => {},
        sendCard: async (card) => void (await sendTo(own.id, card)),
        ...(deps.personTokenFor ? { graphToken: () => deps.personTokenFor!(own.id) } : {}),
      };
      // replayed as if it had been said in that chat: same owner, same privacy, same tools
      return void (await handleMessage(deps, { ...msg, chatId: own.id, conversationType: "personal", conversationReference: own.reference }, privateIo));
    }
  }
  let [definition] = await definitionsForChat(db, msg.chatId);
  if (msg.conversationType === "personal") {
    await recordChatOwner(db, msg.chatId, person.id);
    const usable = await usableDefinitions(db, msg.tenantId, person.id, deps.defaultModel);
    if (msg.text.trim().toLowerCase() === "switch" && usable.length) return void (await io.sendCard(chooseBotCard(usable)));
    // "Jennifer, …" switches the chat to that bot and asks it; "Jennifer" alone only switches
    const named = usable.find((d) => addressedByName(msg.text, d));
    if (named) {
      if (named.id !== definition?.id) await setChatDefinition(db, msg.tenantId, msg.chatId, named.id);
      definition = named;
      if (justName(msg.text, named)) return void (await io.sendCard(chooseBotCard(usable, named.id)));
    }
    if (definition && !usable.some((d) => d.id === definition!.id)) {
      await io.send(`You no longer have access to ${botTitle(definition)}.`);
      return void (usable.length && (await io.sendCard(chooseBotCard(usable))));
    }
    if (!definition) {
      if (!usable.length) return void (await io.send("No bot is available to you yet. Ask an admin."));
      if (usable.length > 1) return void (await io.sendCard(chooseBotCard(usable)));
      await assignToChat(db, msg.chatId, usable[0]!.id);
      definition = usable[0];
    }
  }
  // a company bot named in a group chat takes the chat over, as naming one does in a one-to-one chat: the chat then
  // keeps it, so "Jimmy, are you there?" reaches Jimmy whether or not anyone had assigned the chat before
  if (msg.conversationType !== "personal") {
    const group = (await listDefinitions(db, msg.tenantId)).filter((d) => d.identity !== "person");
    const named = group.find((d) => addressedByName(msg.text, d)) ?? (msg.mentioned && group.length === 1 && !definition ? group[0] : undefined);
    if (named && named.id !== definition?.id && (await mayUseDefinition(db, msg.tenantId, person.id, named.id))) {
      await setChatDefinition(db, msg.tenantId, msg.chatId, named.id);
      definition = named;
    }
  }
  // A confirmation is a question: a typed yes/no answers it, and other messages do not queue behind the waiting turn.
  const pending = deps.confirmations?.pendingFor(msg.chatId, person.id, definition?.id);
  if (pending) {
    const answer = confirmationWord(msg.text);
    if (answer) {
      const outcome = await deps.confirmations!.resolveText(msg.chatId, person.id, answer, definition?.id);
      if (outcome === "confirmed") await io.send("Got it — doing that now.");
      else if (outcome === "denied") await io.send("Okay, I won't do it.");
      else if (outcome === "not_allowed") await io.send("You can't confirm this one.");
      else await io.send("That request has already expired.");
      return;
    }
    const aimed = msg.conversationType === "personal" || msg.mentioned || (definition && addressedByName(msg.text, definition));
    if (aimed) return void (await io.send("I'm waiting for your confirmation on the card above. Say yes or no, or use the buttons."));
  }
  // a group chat the bot may hear in full: it answers only when @mentioned or addressed by name, and keeps the rest as context
  if (msg.conversationType !== "personal" && msg.mentioned === false && !(definition && (addressedByName(msg.text, definition) || (await followUp(db, msg, definition.id, person.id))))) {
    // a photo alone still says something; kept only where the chat is listened to, like the words
    const names = msg.attachments?.map((a) => a.name) ?? [];
    const text = msg.text.trim() || (names.length ? `[sent ${names.join(", ")}]` : "");
    // in the chat's queue, so a question that follows a slow-to-download photo is answered with the photo at hand
    return void (await serialize(`${msg.chatId}:${definition?.id}`, async () => {
      if ((await recordOverheard(db, { tenantId: msg.tenantId, chatId: msg.chatId, personId: person.id, name: person.name, text, ...(msg.receivedAt ? { at: msg.receivedAt } : {}) })) && names.length)
        await storeAttachments(db, { tenantId: msg.tenantId, chatId: msg.chatId, personId: person.id, senderName: person.name, ...(msg.receivedAt ? { at: msg.receivedAt } : {}) }, msg.attachments!);
    }));
  }
  if (msg.conversationType !== "personal" && (!definition || msg.text.trim().toLowerCase() === "switch")) {
    const bots = await groupBots(db, msg.tenantId, person.id);
    if (bots?.length) return void (await io.sendCard(chooseBotCard(bots)));
  }
  if (!definition) return void (await io.send("No bot is set up for this chat yet. An admin can choose one by mentioning me with switch, or on the admin site under Assignments."));
  // Personal acts as one person: only in their own one-to-one chat, whatever the assignment says
  if (definition.identity === "person" && (msg.conversationType !== "personal" || (await ownerOf(db, msg.chatId)) !== person.id || (definition.ownerPersonId && definition.ownerPersonId !== person.id))) return void (await io.send("This assistant is private to its owner."));
  if (!(await mayUseDefinition(db, msg.tenantId, person.id, definition.id))) return void (await io.send("You don't have access to this bot."));
  // the token goes only to the owner's own Personal turn; any other turn never sees it
  const graphToken = definition.identity === "person" ? io.graphToken : undefined;
  // the route was chosen before the assignment or flag changed; the next message goes through sign-in
  if (definition.identity === "person" && !graphToken) return void (await io.send("Say that again, please."));
  void io.typing?.();
  await submitBurst(`${msg.chatId}:${definition.id}:${person.id}`, msg, deps.burstQuietMs ?? 0, async (batch, signal) => {
    const latest = batch[batch.length - 1]!;
    // everything the person said while the bot was busy goes to the model as one message
    const burstText = batch.map((m) => m.text).join("\n");
    return await serialize(`${latest.chatId}:${definition.id}`, async () => {
      const personal = latest.conversationType === "personal";
      // the reply's first line names the bot, in one-to-one chats too: every bot shares the one Teams identity
      const name = botTitle(definition);
      // group chats never stream; a stream that fails hands the rest of the turn to the status message
      let stream = personal ? io.stream : undefined;
      let streamed = false; // the stream showed something, so it must be ended
      let flowing = false; // text is streaming; from here on there are no progress lines
      let newMessage = false; // the next delta starts a later assistant message
      let soFar = ""; // what the stream shows now
      let fellBack = false; // the stream failed: the status message takes over
      const toStream = (f: (s: TeamsStream) => void, text: string) => {
        if (!stream || signal.aborted) return false;
        try {
          f(stream);
          streamed = true;
          soFar = text;
          return true;
        } catch (err) {
          console.error("streaming failed", err instanceof Error ? err.message : "unknown");
          stream = undefined;
          fellBack = true;
          return false;
        }
      };
      // a chat that streams never gets a status message unless the stream failed; once text flows, progress lines would only interrupt it
      const onStream = (t: string) => {
        if (!personal || !io.stream || fellBack || signal.aborted) return false;
        return !stream || flowing || toStream((s) => s.informative(t), t);
      };
      const status = statusMessage(io, personal ? undefined : (t) => withRoleLabel(name, t), onStream);
      const progress = (e: ProgressEvent) => {
        if (signal.aborted) return; // the person has moved on; nothing more from this attempt reaches the chat
        if (!stream) return status.progress(e);
        if (e.kind === "delta") {
          // interim text streams too, after the bot's name; Teams refuses a final message that does not carry on from what was streamed
          const text = (flowing ? (newMessage ? "\n\n" : "") : withRoleLabel(name, "")) + e.text;
          newMessage = false;
          if (toStream((s) => s.chunk(text), (flowing ? soFar : "") + text)) flowing = true;
        } else if (e.kind === "tool") status.progress(e);
        else if (e.kind === "message-end") newMessage = true;
      };
      /** Ends the stream with text (and a card) as its final message; false when there was nothing to end or it failed. */
      const endStream = async (text: string, card?: AdaptiveCard) => {
        const s = stream;
        stream = undefined;
        if (!s || !streamed) return false;
        try {
          await s.end(text, card);
          return true;
        } catch (err) {
          console.error("ending the stream failed", err instanceof Error ? err.message : "unknown");
          fellBack = true;
          return false;
        }
      };
      // a reply still running after SLOW_AFTER_MS says so once, so nobody is left looking at a silent chat
      const slow = setTimeout(() => {
        if (signal.aborted) return;
        if (flowing && stream) {
          if (toStream((s) => s.chunk(`\n\n${SLOW_NOTE}`), `${soFar}\n\n${SLOW_NOTE}`)) newMessage = true;
        } else status.progress({ kind: "text", text: SLOW_NOTE });
      }, SLOW_AFTER_MS);
      const deliver = async (reply: string) => {
        clearTimeout(slow);
        await status.stop();
        if (signal.aborted) return; // the newer message answers instead
        const labelled = withRoleLabel(name, reply);
        const final = !flowing ? labelled : soFar.trimEnd().endsWith(reply.trim()) ? soFar : `${soFar}\n\n${reply}`;
        if (!(await endStream(final))) await status.finish(labelled);
      };
      // a turn that is being replaced still has to close what it opened, or Teams keeps the typing indicator
      const stop = async () => {
        clearTimeout(slow);
        await status.stop();
        if (streamed) await endStream(soFar || "…");
        return true;
      };
      try {
        const heard = personal ? [] : await takeOverheard(db, latest.chatId);
        for (const m of batch)
          if (m.attachments?.length) await storeAttachments(db, { tenantId: m.tenantId, chatId: m.chatId, personId: person.id, senderName: person.name, ...(m.receivedAt ? { at: m.receivedAt } : {}) }, m.attachments);
        const now = latest.receivedAt ?? new Date();
        const result = await deps.runTurn({
          tenantId: latest.tenantId,
          chatId: latest.chatId,
          definition,
          person,
          text: withAttachments(await recentAttachments(db, latest.chatId, now), withOverheard(heard, burstText), now),
          receivedAt: latest.receivedAt,
          signal,
          ...(graphToken ? { graphToken } : {}),
          askConfirmation: async (req) => {
            clearTimeout(slow); // the card says what it is waiting for
            status.supersede();
            // a stream must not stay open through a wait of up to 10 minutes: the card ends it, replacing any progress line;
            // the reply after the card is a new message
            const card = confirmationCard(req);
            if (await endStream(flowing ? soFar : "", card)) return;
            return io.sendCard(card);
          },
          progress,
        });
        if (result.aborted || signal.aborted) return await stop();
        await deliver(result.text);
        // a revoked token can keep coming back from the token service until the person is signed out
        if (result.signInLost)
          await io.signOut?.().catch((e: unknown) => console.error("graph sign-out failed:", e instanceof Error ? e.name : "unknown"));
        try {
          await recordSent(db, result.auditId, new Date());
        } catch (err) {
          console.error("recording turn timing failed", err); // the reply is already delivered; never answer twice
        }
        logTurn(latest.chatId, result.timings);
        return false;
      } catch (err) {
        if (signal.aborted) return await stop();
        console.error(err);
        await deliver("Something went wrong on my side.");
        return false;
      }
    });
  });
}

// agents-hosting hands the handler the whole invoke action ({ verb, data }), not the card's data alone
export function clickPayload(action: unknown): { actionId: string; answer: "yes" | "no" } {
  const obj = (action ?? {}) as { data?: unknown; actionId?: unknown; answer?: unknown };
  const src = obj.data && typeof obj.data === "object" ? (obj.data as typeof obj) : obj;
  return { actionId: String(src.actionId ?? ""), answer: src.answer === "yes" ? "yes" : "no" };
}

export const choosePayload = (action: unknown): string => {
  const obj = (action ?? {}) as { data?: unknown; definitionId?: unknown };
  const src = obj.data && typeof obj.data === "object" ? (obj.data as typeof obj) : obj;
  return String(src.definitionId ?? "");
};

const nameRe = (d: { displayName: string | null; label: string }): RegExp | undefined => {
  const name = (d.displayName || d.label).trim();
  return name ? new RegExp(`^\\W*(?:hey|hi|ok|okay|thanks)?\\W*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu") : undefined;
};
/** "Mickey, …" or "hey mickey …": the message starts with the bot's name (its display name, or its label). */
export const addressedByName = (text: string, d: { displayName: string | null; label: string }): boolean => !!nameRe(d)?.test(text);

/** The sender's own personal assistant, when the message names it — the one bot that may be called from any chat. */
async function personalAssistantNamed(db: Db, msg: IncomingMessage, personId: string) {
  const [me] = await db.select({ on: people.personalBot }).from(people).where(and(eq(people.id, personId), eq(people.tenantId, msg.tenantId)));
  if (!me?.on) return undefined;
  const mine = (await listDefinitions(db, msg.tenantId)).find((d) => d.identity === "person" && d.ownerPersonId === personId);
  return mine && addressedByName(msg.text, mine) ? mine : undefined;
}
/** A typed answer to a confirmation card. Short and unambiguous; anything longer is a normal message. */
const YES = /^(?:yes|y|yeah|yep|yup|ok|okay|sure|confirm|confirmed|do it|go ahead|please do|please)\b/i;
const NO = /^(?:no|n|nope|nah|cancel|decline|don't|do not|stop|leave it)\b/i;
export const confirmationWord = (text: string): "yes" | "no" | undefined => {
  const t = text.trim();
  if (!t || t.length > 40) return undefined;
  if (NO.test(t)) return "no";
  if (YES.test(t)) return "yes";
  return undefined;
};

/** For this long after the bot answers someone in a group chat, their next messages are follow-ups and need no name. */
const FOLLOW_UP_MS = 15 * 60_000;
/** A bot that ended on a question is waiting for an answer; do not stop listening after two minutes. */
const QUESTION_FOLLOW_UP_MS = 30 * 60_000;
/** A group-chat message is a follow-up when the bot answered its sender within the window and it is not aimed at someone else. */
async function followUp(db: Db, msg: IncomingMessage, definitionId: string, personId: string): Promise<boolean> {
  if (msg.mentionedOthers) return false;
  const [last] = await db.select({ at: auditEvents.finishedAt }).from(auditEvents)
    .where(and(eq(auditEvents.chatId, msg.chatId), eq(auditEvents.definitionId, definitionId), eq(auditEvents.personId, personId), eq(auditEvents.kind, "message"), isNotNull(auditEvents.finishedAt)))
    .orderBy(desc(auditEvents.finishedAt)).limit(1);
  if (!last?.at) return false;
  // the bot's last reply is the best signal: a question is still waiting for an answer after the ordinary window
  const [session] = await db.select({ messages: sessions.messages }).from(sessions).where(and(eq(sessions.chatId, msg.chatId), eq(sessions.definitionId, definitionId)));
  const lastReply = [...(session?.messages ?? [])].reverse().find((m) => m.role === "assistant" && (m.text ?? "").trim())?.text?.trim();
  const window = lastReply?.endsWith("?") ? QUESTION_FOLLOW_UP_MS : FOLLOW_UP_MS;
  if ((msg.receivedAt ?? new Date()).getTime() - last.at.getTime() > window) return false;
  // "Ann, can you…" is for Ann: a message that starts with a colleague's first name stays overheard
  const others = await db.select({ name: people.name }).from(people).where(and(eq(people.tenantId, msg.tenantId), ne(people.id, personId)));
  return !others.some((p) => addressedByName(msg.text, { displayName: p.name.split(/\s+/)[0] || null, label: p.name }));
}
/** "Mickey" or "hi mickey!" and nothing more: the person wants to talk to it, not ask it something. */
export const justName = (text: string, d: { displayName: string | null; label: string }): boolean => {
  const re = nameRe(d);
  return !!re?.test(text) && /^\W*$/u.test(text.replace(re, ""));
};

/** The company bots an admin may put in a group chat (it answers everyone there, so only an admin chooses); undefined for anyone else. */
async function groupBots(db: Db, tenantId: string, personId: string) {
  const actor = await loadActor(db, tenantId, personId);
  if (!actor || !isAdmin(actor)) return undefined;
  return (await listDefinitions(db, tenantId)).filter((d) => d.identity === "service");
}

/** The owner picks the bot for their one-to-one chat, an admin for a group chat; anything else changes nothing. */
export async function handleChoose(
  deps: Pick<HandlerDeps, "db" | "defaultModel">,
  who: { tenantId: string; chatId: string; personId: string | undefined },
  definitionId: string,
): Promise<AdaptiveCard> {
  const { db } = deps;
  const refused = resultCard("You can't choose this bot.");
  if (!who.personId) return refused;
  const [chat] = await db.select({ type: chats.conversationType, owner: chats.ownerPersonId }).from(chats).where(and(eq(chats.id, who.chatId), eq(chats.tenantId, who.tenantId)));
  if (chat && chat.type !== "personal") {
    const bots = await groupBots(db, who.tenantId, who.personId);
    if (!bots?.some((d) => d.id === definitionId)) return refused;
    await setChatDefinition(db, who.tenantId, who.chatId, definitionId);
    return chooseBotCard(bots, definitionId);
  }
  if (chat?.type !== "personal" || chat.owner !== who.personId) return refused;
  const usable = await usableDefinitions(db, who.tenantId, who.personId, deps.defaultModel);
  if (!usable.some((d) => d.id === definitionId)) return refused;
  await setChatDefinition(db, who.tenantId, who.chatId, definitionId);
  return chooseBotCard(usable, definitionId);
}

/** Added to a chat: a one-to-one chat with several usable bots opens with the choice, otherwise the greeting. */
export async function handleInstall(
  deps: HandlerDeps,
  chat: { tenantId: string; chatId: string; conversationType: string; from?: { aadObjectId: string; name: string } },
  io: Pick<TeamsIo, "send" | "sendCard">,
): Promise<void> {
  const { db } = deps;
  if (chat.conversationType === "personal" && chat.from) {
    await upsertTenant(db, { id: chat.tenantId });
    const person = await upsertPerson(db, { tenantId: chat.tenantId, aadObjectId: chat.from.aadObjectId, name: chat.from.name });
    await upsertChat(db, { id: chat.chatId, tenantId: chat.tenantId, conversationType: chat.conversationType });
    await recordChatOwner(db, chat.chatId, person.id);
    const usable = await usableDefinitions(db, chat.tenantId, person.id, deps.defaultModel);
    if (usable.length > 1) return io.sendCard(chooseBotCard(usable));
  }
  await io.send(membersAddedGreeting(await tenantBotName(db, chat.tenantId, deps.botName)));
}

export async function handleConfirmClick(
  confirmations: Confirmations,
  data: { actionId: string; answer: "yes" | "no" },
  clickerPersonId: string | undefined,
  clickerName: string,
): Promise<string> {
  const outcome = clickerPersonId ? await confirmations.resolve(data.actionId, clickerPersonId, data.answer) : "not_allowed";
  switch (outcome) {
    case "confirmed":
      return `Confirmed by ${clickerName}`;
    case "denied":
      return `Declined by ${clickerName}`;
    case "not_allowed":
      return "You can't confirm this.";
    case "unknown":
      return "This request has expired.";
  }
}

export const membersAddedGreeting = (botName: string): string => `Hi, I'm ${botName}. Mention me with a question or a job.`;

/** A failed settings lookup must not cost the greeting; it falls back to the environment name. */
export const tenantBotName = (db: Db, tenantId: string, fallback: string): Promise<string> =>
  getTenantSettings(db, tenantId).then((s) => s.botName ?? fallback, () => fallback);
