import type { Db } from "../db/client.js";
import type { Confirmations } from "../engine/confirm.js";
import type { RunResult, RunTurnInput } from "../engine/runner.js";
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
  conversationReference: unknown;
};

// turns per chat and bot definition run one after another, so two never resume the same session at once
const chains = new Map<string, Promise<void>>();

export type HandlerDeps = { db: Db; runTurn: (turn: RunTurnInput) => Promise<RunResult>; botName: string };

export async function handleMessage(
  deps: HandlerDeps,
  msg: IncomingMessage,
  send: (text: string) => Promise<void>,
  sendCard: (card: AdaptiveCard) => Promise<void>,
): Promise<void> {
  const { db } = deps;
  await upsertTenant(db, { id: msg.tenantId });
  const person = await upsertPerson(db, { tenantId: msg.tenantId, aadObjectId: msg.from.aadObjectId, name: msg.from.name });
  await upsertChat(db, { id: msg.chatId, tenantId: msg.tenantId, conversationType: msg.conversationType });
  await saveConversationReference(db, msg.chatId, msg.conversationReference);
  const [definition] = await definitionsForChat(db, msg.chatId);
  if (!definition) return send("No bot is set up for this chat yet.");
  if (!(await mayUseDefinition(db, msg.tenantId, person.id, definition.id))) return send("You don't have access to this bot.");
  const key = `${msg.chatId}:${definition.id}`;
  const turn = (chains.get(key) ?? Promise.resolve()).then(async () => {
    try {
      const result = await deps.runTurn({
        tenantId: msg.tenantId,
        chatId: msg.chatId,
        definition,
        person,
        text: msg.text,
        askConfirmation: (req) => sendCard(confirmationCard(req)),
      });
      await send(msg.conversationType === "personal" ? result.text : withRoleLabel(definition.label, result.text));
    } catch (err) {
      console.error(err);
      await send("Something went wrong on my side.");
    }
  });
  const tail = turn.catch(() => {});
  chains.set(key, tail);
  try {
    await turn;
  } finally {
    if (chains.get(key) === tail) chains.delete(key);
  }
}

// agents-hosting hands the handler the whole invoke action ({ verb, data }), not the card's data alone
export function clickPayload(action: unknown): { actionId: string; answer: "yes" | "no" } {
  const obj = (action ?? {}) as { data?: unknown; actionId?: unknown; answer?: unknown };
  const src = obj.data && typeof obj.data === "object" ? (obj.data as typeof obj) : obj;
  return { actionId: String(src.actionId ?? ""), answer: src.answer === "yes" ? "yes" : "no" };
}

export function handleConfirmClick(
  confirmations: Confirmations,
  data: { actionId: string; answer: "yes" | "no" },
  clickerPersonId: string | undefined,
  clickerName: string,
): string {
  const outcome = clickerPersonId ? confirmations.resolve(data.actionId, clickerPersonId, data.answer) : "not_allowed";
  switch (outcome) {
    case "confirmed":
      return `Confirmed by ${clickerName}`;
    case "denied":
      return `Declined by ${clickerName}`;
    case "not_allowed":
      return "Only the person who asked can confirm this.";
    case "unknown":
      return "This request has expired.";
  }
}

export const membersAddedGreeting = (botName: string): string => `Hi, I'm ${botName}. Mention me with a question or a job.`;

export const tenantBotName = async (db: Db, tenantId: string, fallback: string): Promise<string> =>
  (await getTenantSettings(db, tenantId)).botName ?? fallback;
