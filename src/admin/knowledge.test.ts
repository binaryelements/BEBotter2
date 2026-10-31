import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { testDb } from "../db/test-db.js";
import { listNotes, writeNote } from "../knowledge/store.js";
import { createDepartment, setMembership, setRole } from "../org/directory.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { adminRouter } from "./router.js";
import { serve, sessionCookie } from "./test-server.js";

const secretsKey = Buffer.alloc(32, 5);
const T = "tenant-1";
const U = "tenant-2";
const config = { teams: { clientId: "c", tenantId: T, clientSecret: "s" }, publicUrl: "https://bot.example.test", adminEmails: [], secretsKey };

describe("knowledge screen", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  const id: Record<string, string> = {};

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: T });
    await upsertTenant(db, { id: U });
    for (const name of ["Ann", "Hal"]) id[name] = (await upsertPerson(db, { tenantId: T, aadObjectId: `aad-${name}`, name })).id;
    id.Zed = (await upsertPerson(db, { tenantId: U, aadObjectId: "aad-Zed", name: "Zed" })).id;
    await setRole(db, T, id.Ann, "admin");
    await setRole(db, U, id.Zed, "admin");
    await setMembership(db, T, (await createDepartment(db, T, "Sales")).id, id.Hal, "head");
    const app = express();
    app.use("/admin", adminRouter({ db, config, exchangeCode: async () => ({ id_token: "x" }), verifyIdToken: async () => ({ oid: "", tid: "", name: "", email: "" }), botName: "Bot", defaultModel: "m", fetchUsers: async () => [] }));
    ({ url, close } = await serve(app));
  });
  afterAll(() => close());

  const get = (path: string, who: string, tenant = T) => fetch(url + path, { redirect: "manual", headers: { cookie: sessionCookie(secretsKey, tenant, id[who]) } });
  const post = (path: string, who: string, data: Record<string, string>) =>
    fetch(url + path, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie(secretsKey, T, id[who]) },
      body: new URLSearchParams({ ...data, csrf: "csrf-1" }).toString(),
    });

  it("admin creates, edits and rolls back a note; history shows three versions", async () => {
    expect((await post("/admin/knowledge/note", "Ann", { path: "hosts/pve1", body: "first" })).status).toBe(303);
    await post("/admin/knowledge/note", "Ann", { path: "hosts/pve1", body: "second" });
    expect((await post("/admin/knowledge/rollback", "Ann", { path: "hosts/pve1", version: "1" })).status).toBe(303);
    const t = await (await get("/admin/knowledge/note?path=hosts/pve1", "Ann")).text();
    expect(t).toContain("first</textarea>");
    expect(t).toMatch(/<td>3<\/td>/);
    expect(t).toMatch(/<td>2<\/td>/);
    expect(t).toMatch(/<td>1<\/td>/);
    expect(t).toContain("Ann");
    expect(await (await get("/admin/knowledge", "Ann")).text()).toContain("hosts/pve1");
    expect(await (await get("/admin/knowledge?q=first", "Ann")).text()).toContain("hosts/pve1");
    expect(await (await get("/admin/knowledge?q=zzz", "Ann")).text()).not.toContain("hosts/pve1");
  });

  it("head reads notes but gets 403 on edit, rollback and delete", async () => {
    const t = await (await get("/admin/knowledge/note?path=hosts/pve1", "Hal")).text();
    expect(t).toContain("<pre>first</pre>");
    expect(t).not.toContain("<textarea");
    for (const [p, d] of [["note", { body: "x" }], ["rollback", { version: "1" }], ["delete", {}]] as const)
      expect((await post(`/admin/knowledge/${p}`, "Hal", { path: "hosts/pve1", ...d })).status).toBe(403);
    expect(await (await get("/admin/knowledge", "Hal")).text()).toContain("hosts/pve1");
  });

  it("a body with a private key is refused with 400 and nothing stored", async () => {
    const body = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
    expect((await post("/admin/knowledge/note", "Ann", { path: "hosts/bad", body })).status).toBe(400);
    expect((await listNotes(db, secretsKey, T)).map((n) => n.path)).not.toContain("hosts/bad");
  });

  it("note bodies are escaped", async () => {
    await post("/admin/knowledge/note", "Ann", { path: "xss", body: "<script>alert(1)</script>" });
    const t = await (await get("/admin/knowledge/note?path=xss", "Hal")).text();
    expect(t).not.toContain("<script>alert");
    expect(t).toContain("&lt;script&gt;");
  });

  it("another tenant's admin sees none of the notes", async () => {
    await writeNote(db, secretsKey, T, "private", "mine", {});
    const t = await (await get("/admin/knowledge", "Zed", U)).text();
    expect(t).not.toContain("hosts/pve1");
    expect(t).not.toContain("private");
    expect(await (await get("/admin/knowledge/note?path=private", "Zed", U)).text()).not.toContain("mine");
  });

  it("delete removes the note from the list", async () => {
    const armed = await post("/admin/knowledge/delete", "Ann", { path: "xss" });
    expect(armed.status).toBe(200);
    expect(await armed.text()).toContain('name="path" value="xss"');
    expect((await post("/admin/knowledge/delete", "Ann", { path: "xss", confirm: "yes" })).status).toBe(303);
    expect(await (await get("/admin/knowledge", "Ann")).text()).not.toContain(">xss<");
  });
});
