import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { connections, secretLinks } from "../db/schema.js";
import type { Connection } from "../db/schema.js";
import { DirectoryError } from "../org/directory.js";
import { encrypt } from "../secrets/cipher.js";

const VALID_MS = 30 * 60_000;
const GONE = "This link has expired or was already used.";
const SOMEONE_ELSE = "This link is for someone else.";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Only http and mcp take a pasted secret; an ssh secretCipher is the service's own private key. */
export const takesSecret = (c: Connection) => c.kind === "http" || c.kind === "mcp";

/** The link URL goes into the chat; only the token's hash is stored. */
export async function createSecretLink(db: Db, tenantId: string, connectionId: string, personId: string, publicUrl: string, now = new Date()): Promise<string> {
  const [c] = await db.select().from(connections).where(and(eq(connections.tenantId, tenantId), eq(connections.id, connectionId)));
  if (!c || !takesSecret(c)) throw new DirectoryError("Not found");
  const token = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    await tx.delete(secretLinks).where(and(eq(secretLinks.tenantId, tenantId), eq(secretLinks.connectionId, connectionId), isNull(secretLinks.usedAt)));
    await tx.insert(secretLinks).values({
      id: crypto.randomUUID(), tenantId, connectionId, personId, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + VALID_MS),
    });
  });
  return `${publicUrl}/admin/secret/${token}`;
}

async function openLink(db: Db, tokenHash: string, personId: string, now: Date, lock: boolean) {
  const q = db
    .select({ link: secretLinks, c: connections })
    .from(secretLinks)
    .innerJoin(connections, and(eq(connections.id, secretLinks.connectionId), eq(connections.tenantId, secretLinks.tenantId)))
    .where(eq(secretLinks.tokenHash, tokenHash));
  const [row] = lock ? await q.for("update") : await q;
  // a secret already stored (or a revoked or ssh connection) is never replaced through a link
  if (!row || row.link.usedAt || row.link.expiresAt <= now || !takesSecret(row.c) || row.c.secretCipher || row.c.status === "revoked")
    throw new DirectoryError(GONE);
  if (row.link.personId !== personId) throw new DirectoryError(SOMEONE_ELSE);
  return row;
}

/** The connection a valid link is for, without using it. */
export const secretLinkConnection = async (db: Db, tokenHash: string, personId: string, now = new Date()): Promise<Connection> =>
  (await openLink(db, tokenHash, personId, now, false)).c;

export async function useSecretLink(db: Db, key: Buffer, tokenHash: string, personId: string, secret: string, now = new Date()): Promise<Connection> {
  if (secret.length < 1 || secret.length > 8000 || /[\r\n\0]/.test(secret)) throw new DirectoryError("Paste the secret on one line, up to 8000 characters.");
  return db.transaction(async (tx) => {
    const { link, c } = await openLink(tx, tokenHash, personId, now, true);
    await tx.update(secretLinks).set({ usedAt: now }).where(eq(secretLinks.id, link.id));
    const [row] = await tx
      .update(connections)
      .set({ secretCipher: encrypt(key, secret), updatedAt: now })
      .where(and(eq(connections.tenantId, c.tenantId), eq(connections.id, c.id)))
      .returning();
    return row;
  });
}
