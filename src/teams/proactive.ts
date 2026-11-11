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
  // the token service only has a token once the person has signed in; a turn that signed in through Teams SSO leaves one here
  return token ?? cachedToken(chatId);
}

/**
 * The last token a turn obtained for a chat, kept until it expires. Teams SSO hands the bot a token per message and the
 * token service does not always keep it for a later, headless lookup; a routine an hour after the owner last spoke then
 * has something to act with. A longer gap still needs the owner to message the bot once.
 */
const lastToken = new Map<string, { token: string; expiresAt: number }>();
const JWT_GRACE_MS = 60_000;

export function rememberToken(chatId: string, token: string | undefined): void {
  if (!token) return;
  const exp = tokenExpiry(token);
  if (exp) lastToken.set(chatId, { token, expiresAt: exp });
}

export function cachedToken(chatId: string, now = Date.now()): string | undefined {
  const held = lastToken.get(chatId);
  if (!held) return undefined;
  if (held.expiresAt - JWT_GRACE_MS <= now) {
    lastToken.delete(chatId);
    return undefined;
  }
  return held.token;
}

/** The `exp` claim in seconds, when the token is a JWT. */
function tokenExpiry(token: string): number | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
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
