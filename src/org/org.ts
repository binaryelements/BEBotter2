import { and, eq, isNull, sql } from "drizzle-orm";
import { chats, people, tenants } from "../db/schema.js";
import type { Chat, Person, Tenant } from "../db/schema.js";
import type { Db } from "../db/client.js";
import { validTimeZone } from "../routines/cron.js";
import { DirectoryError } from "./directory.js";

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
  { tenantId, aadObjectId, name, timezone }: { tenantId: string; aadObjectId: string; name: string; timezone?: string },
): Promise<Person> {
  const tz = timezone && validTimeZone(timezone) ? timezone : undefined;
  const [row] = await db
    .insert(people)
    .values({ id: crypto.randomUUID(), tenantId, aadObjectId, name, ...(tz ? { timezone: tz } : {}) })
    .onConflictDoUpdate({ target: [people.tenantId, people.aadObjectId], set: { name, ...(tz ? { timezone: tz } : {}) } })
    .returning();
  // the company's time zone, until an admin sets one: the first person's, since UTC is nobody's
  if (tz) await db.update(tenants).set({ timezone: tz }).where(and(eq(tenants.id, tenantId), eq(tenants.timezone, "UTC")));
  return row;
}

export async function upsertChat(
  db: Db,
  { id, tenantId, conversationType, name }: { id: string; tenantId: string; conversationType: string; name?: string },
): Promise<Chat> {
  // name: what Teams calls the chat (a group chat's topic); it becomes the label until an admin sets one
  const label = name?.trim().slice(0, 80) || null;
  const [row] = await db
    .insert(chats)
    .values({ id, tenantId, conversationType, label, lastSeenAt: new Date() })
    .onConflictDoUpdate({ target: chats.id, set: { conversationType, lastSeenAt: new Date(), label: sql`coalesce(${chats.label}, excluded.label)` } })
    .returning();
  return row;
}

/** Records whose one-to-one chat it is, once. */
export async function recordChatOwner(db: Db, chatId: string, personId: string): Promise<void> {
  await db.update(chats).set({ ownerPersonId: personId }).where(and(eq(chats.id, chatId), isNull(chats.ownerPersonId)));
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

/** timezone, location and country: the defaults every bot is told on every message, unless a chat says otherwise. */
export type TenantSettings = {
  botName: string | null;
  retentionDays: number;
  defaultModel: string | null;
  timezone: string;
  location: string | null;
  country: string | null;
  alertBotId?: string | null;
  alertEmails?: string | null;
  alertLowBalance?: boolean;
  alertFailures?: boolean;
  alertApprovals?: boolean;
  alertBalanceThreshold?: number;
};

export async function getTenantSettings(db: Db, tenantId: string): Promise<TenantSettings> {
  const [row] = await db
    .select({
      botName: tenants.botName,
      retentionDays: tenants.retentionDays,
      defaultModel: tenants.defaultModel,
      timezone: tenants.timezone,
      location: tenants.location,
      country: tenants.country,
      alertBotId: tenants.alertBotId,
      alertEmails: tenants.alertEmails,
      alertLowBalance: tenants.alertLowBalance,
      alertFailures: tenants.alertFailures,
      alertApprovals: tenants.alertApprovals,
      alertBalanceThreshold: tenants.alertBalanceThreshold,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return row ?? { botName: null, retentionDays: 90, defaultModel: null, timezone: "UTC", location: null, country: null, alertBotId: null, alertEmails: null, alertLowBalance: true, alertFailures: true, alertApprovals: false, alertBalanceThreshold: 5 };
}

export async function setTenantSettings(db: Db, tenantId: string, settings: TenantSettings): Promise<void> {
  if (!validTimeZone(settings.timezone)) throw new DirectoryError("Unknown time zone");
  const { alertBotId, alertEmails, alertLowBalance, alertFailures, alertApprovals, alertBalanceThreshold, ...rest } = settings;
  await db
    .update(tenants)
    .set({
      ...rest,
      ...(alertBotId === undefined ? {} : { alertBotId }),
      ...(alertEmails === undefined ? {} : { alertEmails }),
      ...(alertLowBalance === undefined ? {} : { alertLowBalance }),
      ...(alertFailures === undefined ? {} : { alertFailures }),
      ...(alertApprovals === undefined ? {} : { alertApprovals }),
      ...(alertBalanceThreshold === undefined ? {} : { alertBalanceThreshold }),
    })
    .where(eq(tenants.id, tenantId));
}
