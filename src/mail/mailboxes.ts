import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { botDefinitions, mailboxes } from "../db/schema.js";
import { encrypt } from "../secrets/cipher.js";
import type { agentMailAdmin } from "./agentmail.js";
import { MailError } from "./agentmail.js";

export type MailDeps = { db: Db; secretsKey: Buffer; admin: ReturnType<typeof agentMailAdmin>; publicUrl: string };
export type Mailbox = typeof mailboxes.$inferSelect;

const LOCAL_PART = /^[a-z0-9._-]{1,36}$/;
const agentOf = (definitionId: string) => `bb2-${definitionId.slice(0, 12)}`;

export class MailboxError extends Error {
  constructor(readonly reason: "invalid" | "taken" | "removed", message: string) {
    super(message);
    this.name = "MailboxError";
  }
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

const errName = (e: unknown) => (e instanceof Error ? e.name : "error");
const isUniqueViolation = (e: unknown) => [e, (e as { cause?: unknown } | null)?.cause].some((x) => (x as { code?: unknown } | null)?.code === "23505");
const inactive = (m: Mailbox) => m.status === "removed" || m.status === "removing";

const complete = (m: Mailbox) => !!(m.inboxId && m.keyId && m.keyCipher && m.webhookId && m.webhookSecretCipher);

/**
 * Opt-in: records the request as `pending`, then creates whatever is missing. Returns the address, or undefined when BE AgentMail
 * failed or took longer than `timeoutMs` (the row stays pending and a later ensure finishes it).
 */
export async function requestMailbox(deps: MailDeps, definitionId: string, localPart: string, timeoutMs = 15_000): Promise<string | undefined> {
  const { db, admin } = deps;
  const [def] = await db.select().from(botDefinitions).where(eq(botDefinitions.id, definitionId));
  if (!def) return undefined;
  const wanted = localPart.trim().toLowerCase();
  if (!LOCAL_PART.test(wanted)) throw new MailboxError("invalid", "Use 1 to 36 letters, digits, dots, dashes or underscores");
  const existing = await getRow(db, definitionId);
  if (existing && inactive(existing)) throw new MailboxError("removed", "This bot's mailbox was removed; restore it instead");
  // a pending row keeps the address it was first asked for
  if (!existing) {
    const [clash] = await db.select({ id: mailboxes.definitionId }).from(mailboxes).where(eq(mailboxes.localPart, wanted));
    if (clash || (await admin.inboxTaken(wanted))) throw new MailboxError("taken", `The address ${wanted} is already taken`);
    try {
      await db.insert(mailboxes).values({ definitionId, tenantId: def.tenantId, agent: agentOf(definitionId), localPart: wanted, status: "pending" });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // a concurrent request for this bot got there first and continues below; for another bot the address is gone
      if (!(await getRow(db, definitionId))) throw new MailboxError("taken", `The address ${wanted} is already taken`);
    }
  }
  const work = ensureMailbox(deps, definitionId).then(
    (m) => m?.address ?? undefined,
    async (e) => {
      if (!(e instanceof MailboxError)) {
        console.error("mailbox:", errName(e));
        return undefined;
      }
      await db.delete(mailboxes).where(eq(mailboxes.definitionId, definitionId)); // nothing was created
      throw e;
    },
  );
  let timer: number | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** Finishes an existing mailbox row (never creates one) and refreshes its display name. A removed mailbox stays removed. */
export function ensureMailbox(deps: MailDeps, definitionId: string): Promise<Mailbox | undefined> {
  return once(definitionId, () => ensure(deps, definitionId));
}

async function ensure({ db, secretsKey, admin, publicUrl }: MailDeps, id: string): Promise<Mailbox | undefined> {
  const [def] = await db.select().from(botDefinitions).where(eq(botDefinitions.id, id));
  if (!def) return undefined;
  const displayName = def.displayName ? `${def.displayName} (${def.label})` : def.label;
  let row = await getRow(db, id);
  if (!row || inactive(row)) return row;

  if (!row.inboxId) {
    const local = row.localPart;
    if (!local) throw new MailError("Mailbox has no requested address");
    try {
      const made = await admin.createInbox(local, displayName, row.agent);
      row = await patch(db, id, { inboxId: made.id, address: made.address });
    } catch (e) {
      if (!(e instanceof MailError && e.status === 409)) throw e;
      // a lost response may mean the inbox is ours already: adopt it when this bot's agent owns it
      const found = await admin.findInbox(local);
      if (found?.ownerAgent !== row.agent) throw new MailboxError("taken", `The address ${local} is already taken`);
      row = await patch(db, id, { inboxId: found.id, address: found.address });
    }
  } else if (complete(row)) {
    await admin.setDisplayName(row.inboxId, displayName); // a rename changes the display name, never the address
  }
  if (!row.keyId) {
    for (const stray of await admin.listKeys(row.agent)) await admin.revokeKey(stray); // none is recorded, so any is from a lost response
    const k = await admin.issueKey(row.agent, def.name);
    row = await patch(db, id, { keyId: k.id, keyCipher: encrypt(secretsKey, k.key) });
  }
  if (!row.webhookId) {
    for (const stray of await admin.listWebhooks(row.agent)) await admin.removeWebhook(stray);
    const w = await admin.addWebhook(row.agent, `${publicUrl}/mail/inbound`, row.inboxId!);
    row = await patch(db, id, { webhookId: w.id, webhookSecretCipher: encrypt(secretsKey, w.secret) });
  }
  return row.status === "pending" ? patch(db, id, { status: "active" }) : row;
}

/** Marks the mailbox removing, then revokes the key, deletes the webhook and deactivates the inbox; the address is kept for a later restore. */
export function removeMailbox(deps: MailDeps, definitionId: string): Promise<void> {
  return once(definitionId, async () => {
    const { db, admin } = deps;
    let row = await getRow(db, definitionId);
    if (!row || row.status === "removed") return;
    // marked first, so a failure part way cannot be revived by a save or a restart; a retry resumes here
    if (row.status !== "removing") row = await patch(db, definitionId, { status: "removing" });
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

/** Startup: finishes requested mailboxes that are incomplete (pending or missing a piece), one at a time, errors logged by name only. Never creates a row. */
export async function ensureAllMailboxes(deps: MailDeps): Promise<void> {
  for (const m of await deps.db.select().from(mailboxes)) {
    if (inactive(m) || (m.status === "active" && complete(m))) continue;
    const id = m.definitionId;
    try {
      await ensureMailbox(deps, id);
    } catch (e) {
      console.error("mailbox:", errName(e));
    }
  }
}
