import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditEvents, chats, people } from "../db/schema.js";

/** A name an admin recognises for each chat: its label (or Teams name), the owner of a personal chat, else who has spoken there. */
export async function chatNames(db: Db, tenantId: string): Promise<Map<string, string>> {
  const [rows, talkers] = await Promise.all([
    db.select({ id: chats.id, type: chats.conversationType, label: chats.label, owner: people.name }).from(chats).leftJoin(people, eq(people.id, chats.ownerPersonId)).where(eq(chats.tenantId, tenantId)),
    db.select({ chatId: auditEvents.chatId, names: sql<string>`string_agg(distinct ${people.name}, ', ')` }).from(auditEvents)
      .innerJoin(people, eq(people.id, auditEvents.personId)).where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.kind, "message"))).groupBy(auditEvents.chatId),
  ]);
  const who = new Map(talkers.map((t) => [t.chatId, t.names]));
  const name = (c: (typeof rows)[number]) => (c.type === "personal" ? c.owner && `${c.owner} (personal)` : who.get(c.id) && `${who.get(c.id)} (group)`);
  return new Map(rows.map((c) => [c.id, c.label || name(c) || c.id.slice(-12)]));
}
