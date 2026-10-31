import { recordSent } from "../audit/audit.js";
import type { Db } from "../db/client.js";
import type { TurnTimings } from "../db/schema.js";
import type { Confirmations } from "../engine/confirm.js";
import type { ProgressEvent, RunResult, RunTurnInput } from "../engine/runner.js";
import { definitionsForChat } from "../bots/definitions.js";
import { mayUseDefinition } from "../admin/access.js";
import { getTenantSettings, saveConversationReference, upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { confirmationCard, withRoleLabel } from "./cards.js";
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
function logTurn(chatId: string, t: TurnTimings) {
  console.log(`turn ${chatId} ${Date.now() - Date.parse(t.receivedAt)}ms ready=${ms(t.receivedAt, t.engineReadyAt)}ms first=${ms(t.receivedAt, t.firstOutputAt)}ms tools=${t.tools}`);
}

export type TeamsIo = {
  send: (text: string) => Promise<string | undefined>; // resolves to the activity id when there is one
  update: (activityId: string, text: string) => Promise<void>;
  sendCard: (card: AdaptiveCard) => Promise<void>;
};

const STATUS_AFTER_MS = 3000;
const STATUS_EVERY_MS = 2000;

/** One status message for a slow turn: shown after 3 s, edited at most every 2 s (latest wins), then turned into the reply. */
function statusMessage(io: TeamsIo) {
  let label = "";
  let sawText = false;
  let shown = "";
  let id: string | undefined;
  let done = false;
  let last = Date.now() + STATUS_AFTER_MS - STATUS_EVERY_MS; // the first attempt is due STATUS_AFTER_MS from now
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ops: Promise<unknown> = Promise.resolve();

  const flush = async () => {
    timer = undefined;
    if (done || !label || label === shown) return;
    last = Date.now();
    shown = label;
    try {
      if (id) await io.update(id, label);
      else id = await io.send(label);
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
    } else if (!sawText) label = `Working: ${e.toolName.replace(/^mcp__/, "")}…`;
    if (!timer && !done) timer = setTimeout(() => void (ops = ops.then(flush)), Math.max(0, last + STATUS_EVERY_MS - Date.now()));
  };
  /** Replaces the status message with text; sends a new message when there is none or it cannot be edited. */
  const finish = async (text: string) => {
    done = true;
    clearTimeout(timer);
    await ops;
    if (id) {
      try {
        return await io.update(id, text);
      } catch (err) {
        console.error("status message update failed", err);
      }
    }
    id = await io.send(text);
  };
  return { progress, finish };
}

export type HandlerDeps = { db: Db; runTurn: (turn: RunTurnInput) => Promise<RunResult>; botName: string };

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
  const [definition] = await definitionsForChat(db, msg.chatId);
  if (!definition) return void (await io.send("No bot is set up for this chat yet."));
  if (!(await mayUseDefinition(db, msg.tenantId, person.id, definition.id))) return void (await io.send("You don't have access to this bot."));
  await serialize(`${msg.chatId}:${definition.id}`, async () => {
    const status = statusMessage(io);
    try {
      const result = await deps.runTurn({
        tenantId: msg.tenantId,
        chatId: msg.chatId,
        definition,
        person,
        text: msg.text,
        receivedAt: msg.receivedAt,
        askConfirmation: (req) => io.sendCard(confirmationCard(req)),
        progress: status.progress,
      });
      await status.finish(msg.conversationType === "personal" ? result.text : withRoleLabel(definition.label, result.text));
      try {
        await recordSent(db, result.auditId, new Date());
        logTurn(msg.chatId, result.timings);
      } catch (err) {
        console.error("recording turn timing failed", err); // the reply is already delivered; never answer twice
      }
    } catch (err) {
      console.error(err);
      await status.finish("Something went wrong on my side.");
    }
  });
}

// agents-hosting hands the handler the whole invoke action ({ verb, data }), not the card's data alone
export function clickPayload(action: unknown): { actionId: string; answer: "yes" | "no" } {
  const obj = (action ?? {}) as { data?: unknown; actionId?: unknown; answer?: unknown };
  const src = obj.data && typeof obj.data === "object" ? (obj.data as typeof obj) : obj;
  return { actionId: String(src.actionId ?? ""), answer: src.answer === "yes" ? "yes" : "no" };
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
