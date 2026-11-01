import { recordSent } from "../audit/audit.js";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { chats } from "../db/schema.js";
import type { TurnTimings } from "../db/schema.js";
import type { Confirmations } from "../engine/confirm.js";
import type { ProgressEvent, RunResult, RunTurnInput } from "../engine/runner.js";
import { assignToChat, definitionsForChat, setChatDefinition, usableDefinitions } from "../bots/definitions.js";
import { mayUseDefinition } from "../admin/access.js";
import { getTenantSettings, recordChatOwner, saveConversationReference, upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { botTitle, chooseBotCard, confirmationCard, resultCard, toolWords, withRoleLabel } from "./cards.js";
import type { AdaptiveCard } from "./cards.js";

export type IncomingMessage = {
  tenantId: string;
  chatId: string;
  conversationType: string;
  from: { aadObjectId: string; name: string };
  text: string;
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

const ms = (from: string, to?: string) => (to ? Date.parse(to) - Date.parse(from) : "-");
export function logTurn(chatId: string, t: TurnTimings) {
  console.log(`turn ${chatId} ${Date.now() - Date.parse(t.receivedAt)}ms ready=${ms(t.receivedAt, t.engineReadyAt)}ms first=${ms(t.receivedAt, t.firstOutputAt)}ms deliver=${t.resultAt ? Date.now() - Date.parse(t.resultAt) : "-"}ms tools=${t.tools}`);
}

export type TeamsIo = {
  send: (text: string) => Promise<string | undefined>; // resolves to the activity id when there is one
  update: (activityId: string, text: string) => Promise<void>;
  sendCard: (card: AdaptiveCard) => Promise<void>;
  /** A reply typed out as it is written (one-to-one chats); end's text is the whole final message. */
  stream?: TeamsStream;
};
/** end's card, when given, goes out with the final message; finalText may then be empty. */
export type TeamsStream = { informative(text: string): void; chunk(text: string): void; end(finalText: string, card?: AdaptiveCard): Promise<void> };

const STATUS_AFTER_MS = 3000;
const STATUS_EVERY_MS = 2000;

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

export type HandlerDeps = { db: Db; runTurn: (turn: RunTurnInput) => Promise<RunResult>; botName: string; defaultModel: string };

export async function handleMessage(
  deps: HandlerDeps,
  msg: IncomingMessage,
  io: TeamsIo,
): Promise<void> {
  const { db } = deps;
  await upsertTenant(db, { id: msg.tenantId });
  const person = await upsertPerson(db, { tenantId: msg.tenantId, aadObjectId: msg.from.aadObjectId, name: msg.from.name });
  await upsertChat(db, { id: msg.chatId, tenantId: msg.tenantId, conversationType: msg.conversationType });
  await saveConversationReference(db, msg.chatId, msg.conversationReference);
  let [definition] = await definitionsForChat(db, msg.chatId);
  if (msg.conversationType === "personal") {
    await recordChatOwner(db, msg.chatId, person.id);
    const usable = await usableDefinitions(db, msg.tenantId, person.id, deps.defaultModel);
    if (msg.text.trim().toLowerCase() === "switch" && usable.length) return void (await io.sendCard(chooseBotCard(usable)));
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
  if (!definition) return void (await io.send("No bot is set up for this chat yet."));
  if (!(await mayUseDefinition(db, msg.tenantId, person.id, definition.id))) return void (await io.send("You don't have access to this bot."));
  await serialize(`${msg.chatId}:${definition.id}`, async () => {
    const personal = msg.conversationType === "personal";
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
      if (!stream) return false;
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
      if (!personal || !io.stream || fellBack) return false;
      return !stream || flowing || toStream((s) => s.informative(t), t);
    };
    const status = statusMessage(io, personal ? undefined : (t) => withRoleLabel(name, t), onStream);
    const progress = (e: ProgressEvent) => {
      if (!stream) return status.progress(e);
      if (e.kind === "delta") {
        // interim text may stream too; the final message is exactly the reply
        const text = (newMessage && flowing ? "\n\n" : "") + e.text;
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
    const deliver = async (text: string) => {
      await status.stop();
      if (!(await endStream(text))) await status.finish(text);
    };
    try {
      const result = await deps.runTurn({
        tenantId: msg.tenantId,
        chatId: msg.chatId,
        definition,
        person,
        text: msg.text,
        receivedAt: msg.receivedAt,
        askConfirmation: async (req) => {
          status.supersede();
          // a stream must not stay open through a wait of up to 10 minutes: the card ends it, replacing any progress line;
          // the reply after the card is a new message
          const card = confirmationCard(req);
          if (await endStream(flowing ? soFar : "", card)) return;
          return io.sendCard(card);
        },
        progress,
      });
      await deliver(withRoleLabel(name, result.text));
      try {
        await recordSent(db, result.auditId, new Date());
      } catch (err) {
        console.error("recording turn timing failed", err); // the reply is already delivered; never answer twice
      }
      logTurn(msg.chatId, result.timings);
    } catch (err) {
      console.error(err);
      await deliver("Something went wrong on my side.");
    }
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

/** The owner picks the bot for their one-to-one chat; anything else (another person, a bot they may not use) changes nothing. */
export async function handleChoose(
  deps: Pick<HandlerDeps, "db" | "defaultModel">,
  who: { tenantId: string; chatId: string; personId: string | undefined },
  definitionId: string,
): Promise<AdaptiveCard> {
  const { db } = deps;
  const refused = resultCard("You can't choose this bot.");
  if (!who.personId) return refused;
  const [chat] = await db.select({ type: chats.conversationType, owner: chats.ownerPersonId }).from(chats).where(and(eq(chats.id, who.chatId), eq(chats.tenantId, who.tenantId)));
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
