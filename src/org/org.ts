import { and, eq, sql } from "drizzle-orm";
import { ensurePersonalDefinition } from "../bots/definitions.js";
import { chats, people, tenants } from "../db/schema.js";
import type { Chat, Person, Tenant } from "../db/schema.js";
import type { Db } from "../db/client.js";
import { validTimeZone } from "../routines/cron.js";
import { DirectoryError } from "./directory.js";

/** A new tenant gets an empty name until one is known; an existing name is kept when none is given. */
export async function upsertTenant(db: Db, { id, name }: { id: string; name?: string }): Promise<Tenant> {
  const [created] = await db.insert(tenants).values({ id, name: name ?? "" }).onConflictDoNothing().returning();
  if (created) {
    await ensurePersonalDefinition(db, id);
    return created;
  }
  if (name !== undefined) await db.update(tenants).set({ name }).where(eq(tenants.id, id));
  const [row] = await db.select().from(tenants).where(eq(tenants.id, id));
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
    .values({ id, tenantId, conversationType, lastSeenAt: new Date() })
    .onConflictDoUpdate({ target: chats.id, set: { conversationType, lastSeenAt: new Date() } })
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

export type TenantSettings = { botName: string | null; retentionDays: number; defaultModel: string | null; timezone: string };

export async function getTenantSettings(db: Db, tenantId: string): Promise<TenantSettings> {
  const [row] = await db
    .select({ botName: tenants.botName, retentionDays: tenants.retentionDays, defaultModel: tenants.defaultModel, timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return row ?? { botName: null, retentionDays: 90, defaultModel: null, timezone: "UTC" };
}

export async function setTenantSettings(db: Db, tenantId: string, settings: TenantSettings): Promise<void> {
  if (!validTimeZone(settings.timezone)) throw new DirectoryError("Unknown time zone");
  await db.update(tenants).set(settings).where(eq(tenants.id, tenantId));
}
