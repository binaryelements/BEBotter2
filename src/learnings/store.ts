import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { learnings, type Learning } from "../db/schema.js";
import { findSecret } from "../knowledge/secrets-scan.js";
import { DirectoryError } from "../org/directory.js";

export const MAX_LEARNINGS = 100;
const MAX_TEXT = 1000;

const checkText = (text: string) => {
  const t = text.trim();
  if (!t) throw new DirectoryError("A learning needs some text");
  if (t.length > MAX_TEXT) throw new DirectoryError(`A learning is at most ${MAX_TEXT} characters; keep it to one short instruction`);
  const secret = findSecret(t);
  if (secret) throw new DirectoryError(`A learning cannot contain a ${secret}`);
  return t;
};

/** A bot's learnings: every one when `owner` is undefined (the admin site), else the shared ones plus that person's own (a chat). */
export async function listLearnings(db: Db, tenantId: string, definitionId: string, owner?: string | null): Promise<Learning[]> {
  const scope = owner === undefined ? undefined : owner === null ? isNull(learnings.ownerPersonId) : or(isNull(learnings.ownerPersonId), eq(learnings.ownerPersonId, owner));
  return db
    .select()
    .from(learnings)
    .where(and(eq(learnings.tenantId, tenantId), eq(learnings.definitionId, definitionId), scope))
    .orderBy(asc(learnings.createdAt));
}

export async function addLearning(
  db: Db,
  tenantId: string,
  input: { definitionId: string; text: string; taughtByPersonId: string; chatId?: string | null; ownerPersonId?: string | null; source?: "taught" | "reflection" },
): Promise<Learning> {
  const text = checkText(input.text);
  if ((await listLearnings(db, tenantId, input.definitionId)).length >= MAX_LEARNINGS)
    throw new DirectoryError(`This bot already has ${MAX_LEARNINGS} learnings; change or remove some first`);
  const [row] = await db
    .insert(learnings)
    .values({ id: crypto.randomUUID(), tenantId, definitionId: input.definitionId, text, source: input.source ?? "taught", taughtByPersonId: input.taughtByPersonId, chatId: input.chatId ?? null, ownerPersonId: input.ownerPersonId ?? null })
    .returning();
  return row!;
}

// the definition is in every where clause: an id from another bot is refused, not changed
export async function updateLearning(db: Db, tenantId: string, definitionId: string, id: string, text: string): Promise<Learning> {
  const [row] = await db
    .update(learnings)
    .set({ text: checkText(text), updatedAt: new Date() })
    .where(and(eq(learnings.id, id), eq(learnings.tenantId, tenantId), eq(learnings.definitionId, definitionId)))
    .returning();
  if (!row) throw new DirectoryError("No such learning");
  return row;
}

export async function deleteLearning(db: Db, tenantId: string, definitionId: string, id: string): Promise<void> {
  const gone = await db
    .delete(learnings)
    .where(and(eq(learnings.id, id), eq(learnings.tenantId, tenantId), eq(learnings.definitionId, definitionId)))
    .returning({ id: learnings.id });
  if (!gone.length) throw new DirectoryError("No such learning");
}

/** The learnings as the bot's instructions read them; empty when there are none. */
export const learningsNote = (rows: Learning[]) =>
  rows.length
    ? `\n\nWhat people have taught you, oldest first. Follow it unless the person you are talking to now asks otherwise:\n${rows.map((r) => `- ${r.text}`).join("\n")}`
    : "";
