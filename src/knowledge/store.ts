import { and, desc, eq, max } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { knowledgeVersions } from "../db/schema.js";
import type { KnowledgeVersion } from "../db/schema.js";
import { decrypt, encrypt } from "../secrets/cipher.js";
import { findSecret } from "./secrets-scan.js";

export class KnowledgeError extends Error {}

export type Author = { personId?: string; definitionId?: string; chatId?: string };

const PATH = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){0,4}$/;
const MAX_BODY = 100_000;

function checkPath(path: string): void {
  if (path.length > 200 || !PATH.test(path) || path.split("/").some((s) => s === "..")) throw new KnowledgeError("Invalid note path");
}

const scope = (tenantId: string, path: string) => and(eq(knowledgeVersions.tenantId, tenantId), eq(knowledgeVersions.path, path));

async function latestRows(db: Db, tenantId: string): Promise<KnowledgeVersion[]> {
  const rows = await db
    .selectDistinctOn([knowledgeVersions.path])
    .from(knowledgeVersions)
    .where(eq(knowledgeVersions.tenantId, tenantId))
    .orderBy(knowledgeVersions.path, desc(knowledgeVersions.version));
  return rows.filter((r) => !r.deleted);
}

async function latestRow(db: Db, tenantId: string, path: string): Promise<KnowledgeVersion | undefined> {
  const [row] = await db.select().from(knowledgeVersions).where(scope(tenantId, path)).orderBy(desc(knowledgeVersions.version)).limit(1);
  return row && !row.deleted ? row : undefined;
}

export async function listNotes(db: Db, _key: Buffer, tenantId: string): Promise<{ path: string; version: number; updatedAt: Date }[]> {
  return (await latestRows(db, tenantId)).map((r) => ({ path: r.path, version: r.version, updatedAt: r.createdAt }));
}

export async function readNote(db: Db, key: Buffer, tenantId: string, path: string): Promise<{ path: string; version: number; body: string } | undefined> {
  const row = await latestRow(db, tenantId, path);
  return row && { path, version: row.version, body: decrypt(key, row.bodyCipher) };
}

export async function searchNotes(db: Db, key: Buffer, tenantId: string, query: string, limit = 20): Promise<{ path: string; snippet: string }[]> {
  const q = query.toLowerCase();
  const hits: { path: string; snippet: string }[] = [];
  // shortcut: decrypts every latest note per search; add an index when a tenant holds thousands of notes.
  for (const r of await latestRows(db, tenantId)) {
    if (hits.length >= limit) break;
    const body = decrypt(key, r.bodyCipher);
    const at = body.toLowerCase().indexOf(q);
    if (at >= 0) {
      const from = Math.max(0, at - 80);
      hits.push({ path: r.path, snippet: body.slice(from, from + 200) });
    } else if (r.path.includes(q)) hits.push({ path: r.path, snippet: body.slice(0, 200) });
  }
  return hits;
}

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null && ((e as { code?: string }).code === "23505" || isUniqueViolation((e as { cause?: unknown }).cause));

async function append(db: Db, key: Buffer, tenantId: string, path: string, body: string, deleted: boolean, author: Author): Promise<number> {
  const bodyCipher = encrypt(key, body);
  for (let attempt = 0; ; attempt++) {
    const [{ v }] = await db.select({ v: max(knowledgeVersions.version) }).from(knowledgeVersions).where(scope(tenantId, path));
    const version = (v ?? 0) + 1;
    try {
      await db.insert(knowledgeVersions).values({
        id: crypto.randomUUID(), tenantId, path, version, bodyCipher, deleted,
        authorPersonId: author.personId, authorDefinitionId: author.definitionId, chatId: author.chatId,
      });
      return version;
    } catch (e) {
      if (attempt > 0 || !isUniqueViolation(e)) throw e;
    }
  }
}

export async function writeNote(db: Db, key: Buffer, tenantId: string, path: string, body: string, author: Author): Promise<number> {
  checkPath(path);
  if (body.length > MAX_BODY) throw new KnowledgeError("Note is too long");
  const secret = findSecret(body);
  if (secret) throw new KnowledgeError(`Note not saved: it looks like it contains a ${secret}`);
  return append(db, key, tenantId, path, body, false, author);
}

export async function noteHistory(db: Db, key: Buffer, tenantId: string, path: string): Promise<(KnowledgeVersion & { body: string })[]> {
  const rows = await db.select().from(knowledgeVersions).where(scope(tenantId, path)).orderBy(desc(knowledgeVersions.version));
  return rows.map((r) => ({ ...r, body: decrypt(key, r.bodyCipher) }));
}

export async function rollbackNote(db: Db, key: Buffer, tenantId: string, path: string, version: number, author: Author): Promise<number> {
  const old = (await noteHistory(db, key, tenantId, path)).find((r) => r.version === version);
  if (!old || old.deleted) throw new KnowledgeError("No such version");
  return writeNote(db, key, tenantId, path, old.body, author);
}

export async function deleteNote(db: Db, key: Buffer, tenantId: string, path: string, author: Author): Promise<void> {
  await append(db, key, tenantId, path, "", true, author);
}
