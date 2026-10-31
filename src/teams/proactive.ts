import { eq } from "drizzle-orm";
import { CardFactory, MessageFactory } from "@microsoft/agents-hosting";
import type { CloudAdapter } from "@microsoft/agents-hosting";
import type { Db } from "../db/client.js";
import { chats } from "../db/schema.js";
import type { AdaptiveCard } from "./cards.js";

type Reference = Parameters<CloudAdapter["continueConversation"]>[1];

export async function sendToChat(
  deps: { db: Db; adapter: Pick<CloudAdapter, "continueConversation">; botAppId: string },
  chatId: string,
  message: string | AdaptiveCard,
): Promise<void> {
  const [chat] = await deps.db.select({ reference: chats.conversationReference }).from(chats).where(eq(chats.id, chatId));
  if (!chat?.reference) throw new Error(`No conversation reference for chat ${chatId}`);
  await deps.adapter.continueConversation(deps.botAppId, chat.reference as Reference, async (ctx) => {
    await ctx.sendActivity(typeof message === "string" ? message : MessageFactory.attachment(CardFactory.adaptiveCard(message)));
  });
}
