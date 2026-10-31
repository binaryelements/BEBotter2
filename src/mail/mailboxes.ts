import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { botDefinitions, mailboxes } from "../db/schema.js";
import { encrypt } from "../secrets/cipher.js";
import type { agentMailAdmin } from "./agentmail.js";
import { MailError } from "./agentmail.js";

export type MailDeps = { db: Db; secretsKey: Buffer; admin: ReturnType<typeof agentMailAdmin>; publicUrl: string };
export type Mailbox = typeof mailboxes.$inferSelect;

const MAX_LOCAL = 36;
const MAX_ATTEMPTS = 50;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
const agentOf = (definitionId: string) => `bb2-${definitionId.slice(0, 12)}`;

/** Candidate local parts: the name, then name-<definition name>, then name-2, name-3... */
function* candidates(name: string, defName: string): Generator<string> {
  const base = slug(name).slice(0, MAX_LOCAL);
  yield base;
  yield `${base.slice(0, MAX_LOCAL - defName.length - 1)}-${slug(defName)}`.slice(0, MAX_LOCAL);
  for (let n = 2; ; n++) yield `${base.slice(0, MAX_LOCAL - String(n).length - 1)}-${n}`;
}

// one create at a time per bot, so a save and the startup backfill never make two inboxes
const running = new Map<string, Promise<unknown>>();
function once<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const next = (running.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn);
  running.set(id, next);
  void next.finally(() => running.get(id) === next && running.delete(id)).catch(() => undefined);
  return next;
}

const getRow = async (db: Db, id: string): Promise<Mailbox | undefined> => (await db.select().from(mailboxes).where(eq(mailboxes.definitionId, id)))[0];
const patch = async (db: Db, id: string, set: Partial<Mailbox>): Promise<Mailbox> =>
  (await db.update(mailboxes).set({ ...set, updatedAt: new Date() }).where(eq(mailboxes.definitionId, id)).returning())[0]!;

const complete = (m: Mailbox) => !!(m.inboxId && m.keyId && m.keyCipher && m.webhookId && m.webhookSecretCipher);

/** Creates whatever is missing, storing each piece as soon as it exists so a retry resumes. A removed mailbox stays removed. */
export function ensureMailbox(deps: MailDeps, definitionId: string): Promise<Mailbox | undefined> {
  return once(definitionId, () => ensure(deps, definitionId));
}

async function ensure({ db, secretsKey, admin, publicUrl }: MailDeps, id: string): Promise<Mailbox | undefined> {
  const [def] = await db.select().from(botDefinitions).where(eq(botDefinitions.id, id));
  if (!def) return undefined;
  const displayName = def.displayName ? `${def.displayName} (${def.label})` : def.label;
  let row = await getRow(db, id);
  if (!row) {
    await db.insert(mailboxes).values({ definitionId: id, tenantId: def.tenantId, agent: agentOf(id), status: "active" }).onConflictDoNothing();
    row = (await getRow(db, id))!;
  }
  if (row.status === "removed") return row;

  if (!row.inboxId) {
    const taken = new Set((await db.select({ a: mailboxes.address }).from(mailboxes)).map((r) => r.a?.split("@")[0]?.toLowerCase()));
    let made: { id: string; address: string } | undefined;
    let tried = 0;
    for (const local of candidates(def.displayName ?? def.name, def.name)) {
      if (++tried > MAX_ATTEMPTS) throw new MailError("No free mail address found");
      if (taken.has(local) || (await admin.inboxTaken(local))) continue;
      try {
        made = await admin.createInbox(local, displayName, row.agent);
        break;
      } catch (e) {
        if (!(e instanceof MailError && e.status === 409)) throw e;
      }
    }
    row = await patch(db, id, { inboxId: made!.id, address: made!.address });
  } else if (complete(row)) {
    await admin.setDisplayName(row.inboxId, displayName); // a rename changes the display name, never the address
  }
  if (!row.keyId) {
    const k = await admin.issueKey(row.agent, def.name);
    row = await patch(db, id, { keyId: k.id, keyCipher: encrypt(secretsKey, k.key) });
  }
  if (!row.webhookId) {
    const w = await admin.addWebhook(row.agent, `${publicUrl}/mail/inbound`, row.inboxId!);
    row = await patch(db, id, { webhookId: w.id, webhookSecretCipher: encrypt(secretsKey, w.secret) });
  }
  return row;
}

/** Revokes the key, deletes the webhook and deactivates the inbox; the address is kept for a later restore. */
export function removeMailbox(deps: MailDeps, definitionId: string): Promise<void> {
  return once(definitionId, async () => {
    const { db, admin } = deps;
    let row = await getRow(db, definitionId);
    if (!row || row.status === "removed") return;
    if (row.keyId) row = await patch(db, definitionId, (await admin.revokeKey(row.keyId), { keyId: null, keyCipher: null }));
    if (row.webhookId) row = await patch(db, definitionId, (await admin.removeWebhook(row.webhookId), { webhookId: null, webhookSecretCipher: null }));
    if (row.inboxId) await admin.setInboxActive(row.inboxId, false);
    await patch(db, definitionId, { status: "removed" });
  });
}

export async function restoreMailbox(deps: MailDeps, definitionId: string): Promise<Mailbox | undefined> {
  return once(definitionId, async () => {
    const row = await getRow(deps.db, definitionId);
    if (row?.inboxId) await deps.admin.setInboxActive(row.inboxId, true);
    if (row) await patch(deps.db, definitionId, { status: "active" });
    return ensure(deps, definitionId);
  });
}

/** Startup backfill: bots without a finished mailbox, one at a time, errors logged by name only. */
export async function ensureAllMailboxes(deps: MailDeps): Promise<void> {
  const defs = await deps.db.select({ id: botDefinitions.id }).from(botDefinitions);
  const rows = new Map((await deps.db.select().from(mailboxes)).map((m) => [m.definitionId, m]));
  for (const { id } of defs) {
    const m = rows.get(id);
    if (m && (m.status === "removed" || complete(m))) continue;
    try {
      await ensureMailbox(deps, id);
    } catch (e) {
      console.error("mailbox:", e instanceof Error ? e.name : "error");
    }
  }
}
