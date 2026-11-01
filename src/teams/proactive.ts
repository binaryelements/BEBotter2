import { eq } from "drizzle-orm";
import { CardFactory, MessageFactory } from "@microsoft/agents-hosting";
import type { CloudAdapter, TurnContext } from "@microsoft/agents-hosting";
import type { Db } from "../db/client.js";
import { chats } from "../db/schema.js";
import type { AdaptiveCard } from "./cards.js";

type Reference = Parameters<CloudAdapter["continueConversation"]>[1];
type ProactiveDeps = { db: Db; adapter: Pick<CloudAdapter, "continueConversation">; botAppId: string };

const referenceOf = async (db: Db, chatId: string) => (await db.select({ reference: chats.conversationReference }).from(chats).where(eq(chats.id, chatId)))[0]?.reference;

/** The owner's token for a one-to-one chat, outside any turn: the token service keys it on the user in the chat's stored reference. */
export async function personToken(deps: ProactiveDeps, chatId: string, getToken: (ctx: TurnContext) => Promise<string | undefined>): Promise<string | undefined> {
  const reference = await referenceOf(deps.db, chatId);
  if (!reference) return undefined;
  let token: string | undefined;
  await deps.adapter.continueConversation(deps.botAppId, reference as Reference, async (ctx) => {
    token = await getToken(ctx);
  });
  return token;
}

export async function sendToChat(
  deps: ProactiveDeps,
  chatId: string,
  message: string | AdaptiveCard,
): Promise<void> {
  const reference = await referenceOf(deps.db, chatId);
  if (!reference) throw new Error(`No conversation reference for chat ${chatId}`);
  await deps.adapter.continueConversation(deps.botAppId, reference as Reference, async (ctx) => {
    await ctx.sendActivity(typeof message === "string" ? message : MessageFactory.attachment(CardFactory.adaptiveCard(message)));
  });
}
