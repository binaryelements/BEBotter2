import { and, asc, eq, isNull, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { chatMessages, chats } from "../db/schema.js";

const MAX_TEXT = 2000;
/** At most this many lines go to the bot in one turn; older unread ones are dropped as read. */
const MAX_LINES = 60;

/** Keeps a group-chat message the bot was not addressed by, unless an admin switched listening off there. */
export async function recordOverheard(db: Db, m: { tenantId: string; chatId: string; personId?: string; name: string; text: string; at?: Date }): Promise<boolean> {
  const text = m.text.trim().slice(0, MAX_TEXT);
  if (!text) return false;
  const [chat] = await db.select({ listening: chats.listening }).from(chats).where(and(eq(chats.id, m.chatId), eq(chats.tenantId, m.tenantId)));
  if (!chat?.listening) return false;
  await db.insert(chatMessages).values({ id: crypto.randomUUID(), tenantId: m.tenantId, chatId: m.chatId, personId: m.personId ?? null, name: m.name, text, at: m.at ?? new Date() });
  return true;
}

/** The lines said since the bot's last turn in the chat, oldest first, now marked as read. */
export async function takeOverheard(db: Db, chatId: string, now = new Date()): Promise<string[]> {
  const rows = await db.select({ id: chatMessages.id, name: chatMessages.name, text: chatMessages.text }).from(chatMessages)
    .where(and(eq(chatMessages.chatId, chatId), isNull(chatMessages.usedAt))).orderBy(asc(chatMessages.at));
  if (!rows.length) return [];
  await db.update(chatMessages).set({ usedAt: now }).where(and(eq(chatMessages.chatId, chatId), isNull(chatMessages.usedAt)));
  return rows.slice(-MAX_LINES).map((r) => `${r.name}: ${r.text.replace(/\s*\n\s*/g, " ")}`);
}

/** Prefixes the message with what the bot heard but did not answer, so the turn knows what the chat was discussing. */
export const withOverheard = (lines: string[], text: string): string =>
  lines.length ? `[Said in this group chat since your last reply; you were not addressed, so you did not answer:\n${lines.join("\n")}]\n\n${text}` : text;

export async function pruneOverheard(db: Db, tenantId: string, retentionDays: number, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  return (await db.delete(chatMessages).where(and(eq(chatMessages.tenantId, tenantId), lt(chatMessages.at, cutoff))).returning({ id: chatMessages.id })).length;
}

export async function setChatListening(db: Db, tenantId: string, chatId: string, listening: boolean): Promise<void> {
  await db.update(chats).set({ listening }).where(and(eq(chats.id, chatId), eq(chats.tenantId, tenantId)));
}
