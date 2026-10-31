import { and, eq, sql } from "drizzle-orm";
import { chats, people, tenants } from "../db/schema.js";
import type { Chat, Person, Tenant } from "../db/schema.js";
import type { Db } from "../db/client.js";

/** A new tenant gets an empty name until one is known; an existing name is kept when none is given. */
export async function upsertTenant(db: Db, { id, name }: { id: string; name?: string }): Promise<Tenant> {
  const [row] = await db
    .insert(tenants)
    .values({ id, name: name ?? "" })
    .onConflictDoUpdate({ target: tenants.id, set: { name: name ?? sql`${tenants.name}` } })
    .returning();
  return row;
}

export async function upsertPerson(
  db: Db,
  { tenantId, aadObjectId, name }: { tenantId: string; aadObjectId: string; name: string },
): Promise<Person> {
  const [row] = await db
    .insert(people)
    .values({ id: crypto.randomUUID(), tenantId, aadObjectId, name })
    .onConflictDoUpdate({ target: [people.tenantId, people.aadObjectId], set: { name } })
    .returning();
  return row;
}

export async function upsertChat(
  db: Db,
  { id, tenantId, conversationType }: { id: string; tenantId: string; conversationType: string },
): Promise<Chat> {
  const [row] = await db
    .insert(chats)
    .values({ id, tenantId, conversationType })
    .onConflictDoUpdate({ target: chats.id, set: { conversationType } })
    .returning();
  return row;
}

export async function saveConversationReference(db: Db, chatId: string, reference: unknown): Promise<void> {
  await db.update(chats).set({ conversationReference: reference }).where(eq(chats.id, chatId));
}

export async function findPersonId(db: Db, tenantId: string, aadObjectId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.tenantId, tenantId), eq(people.aadObjectId, aadObjectId)));
  return row?.id;
}
