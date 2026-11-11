import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { testDb } from "../db/test-db.js";
import type { Db } from "../db/client.js";
import { upsertTenant } from "../org/org.js";
import { upsertDefinition } from "../bots/definitions.js";
import { deleteNote, KnowledgeError, listNotes, noteHistory, readNote, rollbackNote, searchNotes, writeNote } from "./store.js";

describe("knowledge store", () => {
  let db: Db;
  const key = randomBytes(32);
  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: "t1" });
    await upsertTenant(db, { id: "t2" });
  });

  it("write, read, list return the latest version", async () => {
    await writeNote(db, key, "t1", "a/one", "first", {});
    await writeNote(db, key, "t1", "a/one", "second", {});
    await writeNote(db, key, "t1", "a/zed", "other", {});
    expect(await readNote(db, key, "t1", "a/one")).toEqual({ path: "a/one", version: 2, body: "second", definitionId: null });
    expect((await listNotes(db, key, "t1")).map((n) => [n.path, n.version])).toEqual([["a/one", 2], ["a/zed", 1]]);
    expect(await searchNotes(db, key, "t1", "SECON")).toEqual([{ path: "a/one", snippet: "second" }]);
  });

  it("a bot sees its own notes and the shared ones, never another bot's", async () => {
    const a = await upsertDefinition(db, key, "t1", { name: "bot-a", label: "A", persona: "p" });
    const b = await upsertDefinition(db, key, "t1", { name: "bot-b", label: "B", persona: "p" });
    await writeNote(db, key, "t1", "shared/x", "for everyone", {});
    await writeNote(db, key, "t1", "mine/x", "for a", { definitionId: a.id });
    await writeNote(db, key, "t1", "theirs/x", "for b", { definitionId: b.id });
    const visibleToA = (await listNotes(db, key, "t1", a.id)).map((n) => n.path);
    expect(visibleToA).toContain("mine/x");
    expect(visibleToA).toContain("shared/x");
    expect(visibleToA).not.toContain("theirs/x");
    expect((await readNote(db, key, "t1", "shared/x", a.id))?.body).toBe("for everyone");
    expect(await readNote(db, key, "t1", "theirs/x", a.id)).toBeUndefined();
    expect(await searchNotes(db, key, "t1", "for b", 20, a.id)).toEqual([]);
    // an admin asks with no bot and sees every note, with its owner
    const all = (await listNotes(db, key, "t1")).filter((n) => n.path.endsWith("/x"));
    expect(all.map((n) => [n.path, n.definitionId]).sort()).toEqual([["mine/x", a.id], ["shared/x", null], ["theirs/x", b.id]].sort());
  });

  it("versions increase and history is newest first with authors", async () => {
    await writeNote(db, key, "t1", "h", "v1", { chatId: "c1" });
    await writeNote(db, key, "t1", "h", "v2", { chatId: "c2" });
    const h = await noteHistory(db, key, "t1", "h");
    expect(h.map((r) => [r.version, r.body, r.chatId])).toEqual([[2, "v2", "c2"], [1, "v1", "c1"]]);
  });

  it("rollback writes a new version with the old body", async () => {
    await writeNote(db, key, "t1", "r", "old", {});
    await writeNote(db, key, "t1", "r", "new", {});
    expect(await rollbackNote(db, key, "t1", "r", 1, {})).toBe(3);
    expect((await readNote(db, key, "t1", "r"))?.body).toBe("old");
  });

  it("rollback refuses a deleted version", async () => {
    await writeNote(db, key, "t1", "d", "old", {});
    await deleteNote(db, key, "t1", "d", {});
    await expect(rollbackNote(db, key, "t1", "d", 2, {})).rejects.toThrow(/No such version/);
    expect(await readNote(db, key, "t1", "d")).toBeUndefined();
  });

  it("deleted notes vanish from list, read and search but stay in history", async () => {
    await writeNote(db, key, "t1", "gone", "findme", {});
    await deleteNote(db, key, "t1", "gone", {});
    expect(await readNote(db, key, "t1", "gone")).toBeUndefined();
    expect((await listNotes(db, key, "t1")).some((n) => n.path === "gone")).toBe(false);
    expect(await searchNotes(db, key, "t1", "findme")).toEqual([]);
    expect(await noteHistory(db, key, "t1", "gone")).toHaveLength(2);
  });

  it("tenant A cannot read or list tenant B's note at the same path", async () => {
    await writeNote(db, key, "t2", "shared", "b only", {});
    expect(await readNote(db, key, "t1", "shared")).toBeUndefined();
    expect((await listNotes(db, key, "t1")).some((n) => n.path === "shared")).toBe(false);
    expect(await noteHistory(db, key, "t1", "shared")).toEqual([]);
  });

  it("body is encrypted at rest", async () => {
    await writeNote(db, key, "t1", "enc", "plaintext-marker", {});
    const res = await db.execute(sql`select body_cipher from knowledge_versions where path = 'enc'`);
    expect(JSON.stringify(res)).not.toContain("plaintext-marker");
  });

  it("concurrent writes to one path get distinct versions", async () => {
    const vs = await Promise.all([1, 2].map((i) => writeNote(db, key, "t1", "race", `b${i}`, {})));
    expect(new Set(vs).size).toBe(2);
  });

  it("invalid paths are refused", async () => {
    for (const p of ["../x", "/abs", "A/Up", "a//b", "a/../b", "a".repeat(201), "a/b/c/d/e/f"]) {
      await expect(writeNote(db, key, "t1", p, "x", {})).rejects.toThrow(KnowledgeError);
    }
  });

  it("refuses secrets and oversize bodies", async () => {
    await expect(writeNote(db, key, "t1", "s", "password: hunter2", {})).rejects.toThrow(KnowledgeError);
    await expect(writeNote(db, key, "t1", "s", "x".repeat(100_001), {})).rejects.toThrow(KnowledgeError);
  });
});
