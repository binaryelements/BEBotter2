import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { upsertDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { secretLinks } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { decrypt } from "../secrets/cipher.js";
import { createSecretLink, hashToken, secretLinkConnection, useSecretLink } from "./secret-links.js";
import { fakeSsh } from "./ssh.js";
import { getConnection, requestConnection } from "./store.js";

const key = randomBytes(32);
const publicUrl = "https://bot.example.test";
const now = new Date("2026-10-30T10:00:00Z");

describe("secret links", () => {
  let db: Db;
  let ann: string, bob: string, connectionId: string;
  beforeEach(async () => {
    db = await testDb();
    await upsertTenant(db, { id: "t1" });
    const definitionId = (await upsertDefinition(db, key, "t1", { name: "ops", label: "Ops", persona: "p" })).id;
    ann = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "a1", name: "Ann" })).id;
    bob = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "a2", name: "Bob" })).id;
    const { connection } = await requestConnection({ db, ssh: fakeSsh(), secretsKey: key }, "t1", {
      kind: "http", name: "api", target: "https://api.example.test/", mode: "read-only", config: { auth: { in: "header", name: "Authorization" } }, definitionId, personId: ann,
    });
    connectionId = connection.id;
  });
  const link = async (at = now) => (await createSecretLink(db, "t1", connectionId, ann, publicUrl, at)).split("/").pop()!;

  it("a link stores the secret encrypted once; a second use fails", async () => {
    const token = await link();
    const c = await useSecretLink(db, key, "t1", hashToken(token), ann, "tok-123", now);
    expect(c.secretCipher).not.toContain("tok-123");
    expect(decrypt(key, (await getConnection(db, "t1", "api"))!.secretCipher!)).toBe("tok-123");
    await expect(useSecretLink(db, key, "t1", hashToken(token), ann, "tok-456", now)).rejects.toThrow("This link has expired or was already used.");
    expect(decrypt(key, (await getConnection(db, "t1", "api"))!.secretCipher!)).toBe("tok-123");
  });

  it("an expired link fails", async () => {
    const token = await link();
    await expect(useSecretLink(db, key, "t1", hashToken(token), ann, "tok", new Date(now.getTime() + 30 * 60_000))).rejects.toThrow("This link has expired or was already used.");
    expect((await getConnection(db, "t1", "api"))!.secretCipher).toBeNull();
  });

  it("another person cannot use the link", async () => {
    const token = await link();
    await expect(useSecretLink(db, key, "t1", hashToken(token), bob, "tok", now)).rejects.toThrow("This link is for someone else.");
    expect((await getConnection(db, "t1", "api"))!.secretCipher).toBeNull();
  });

  it("a link fails under another tenant's session", async () => {
    await upsertTenant(db, { id: "t2" });
    const token = await link();
    await expect(useSecretLink(db, key, "t2", hashToken(token), ann, "tok", now)).rejects.toThrow("This link has expired or was already used.");
    await expect(secretLinkConnection(db, "t2", hashToken(token), ann, now)).rejects.toThrow("expired");
    expect((await secretLinkConnection(db, "t1", hashToken(token), ann, now)).name).toBe("api");
  });

  it("only the person who requested the connection gets a link", async () => {
    await expect(createSecretLink(db, "t1", connectionId, bob, publicUrl, now)).rejects.toThrow();
    expect(await db.select().from(secretLinks)).toEqual([]);
  });

  it("only the token hash is stored", async () => {
    const url = await createSecretLink(db, "t1", connectionId, ann, publicUrl, now);
    const token = url.split("/").pop()!;
    expect(url).toBe(`${publicUrl}/admin/secret/${token}`);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    const rows = await db.select().from(secretLinks);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0].expiresAt).toEqual(new Date(now.getTime() + 30 * 60_000));
  });

  it("a new link replaces the earlier unused one", async () => {
    const first = await link();
    const second = await link();
    await expect(useSecretLink(db, key, "t1", hashToken(first), ann, "tok", now)).rejects.toThrow("expired or was already used");
    await useSecretLink(db, key, "t1", hashToken(second), ann, "tok", now);
  });

  it("refuses multi-line, empty or oversized secrets", async () => {
    const token = await link();
    for (const s of ["", "a\nb", "a\rb", "a\0b", "x".repeat(8001)])
      await expect(useSecretLink(db, key, "t1", hashToken(token), ann, s, now)).rejects.toThrow("one line");
    await useSecretLink(db, key, "t1", hashToken(token), ann, "x".repeat(8000), now);
  });

  it("an ssh connection gets no link", async () => {
    const definitionId = (await upsertDefinition(db, key, "t1", { name: "ops2", label: "Ops2", persona: "p" })).id;
    const { connection } = await requestConnection({ db, ssh: fakeSsh(), secretsKey: key }, "t1", {
      kind: "ssh", name: "pve1", target: "pve1.example.test", mode: "read-only", config: { port: 22, username: "bot" }, definitionId, personId: ann,
    });
    await expect(createSecretLink(db, "t1", connection.id, ann, publicUrl, now)).rejects.toThrow();
  });
});
