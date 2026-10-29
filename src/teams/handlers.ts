import type { Db } from "../db/client.js";
import type { Confirmations } from "../engine/confirm.js";
import type { RunResult, RunTurnInput } from "../engine/runner.js";
import { definitionsForChat } from "../bots/definitions.js";
import { saveConversationReference, upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
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
