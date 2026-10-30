import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "../db/test-db.js";
import type { Db } from "../db/client.js";
import { createDepartment, listDepartments, listPeople, setMembership, setRole } from "../org/directory.js";
import type { FetchUsers } from "../org/directory-sync.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { adminRouter } from "./router.js";
import { serve, sessionCookie } from "./test-server.js";

const secretsKey = Buffer.alloc(32, 5);
const T = "tenant-1";
const config = {
  teams: { clientId: "client-1", tenantId: T, clientSecret: "s" },
  publicUrl: "https://bot.example.test",
  adminEmails: [],
  secretsKey,
};

describe("people and departments screens", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  const id: Record<string, string> = {};
  let sales: string, eng: string, foreignDept: string;
  let directory: FetchUsers = async () => [];

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: T });
    await upsertTenant(db, { id: "tenant-2" });
    for (const name of ["Ann", "Hal", "Mo", "Ola", "Eve", "<script>alert(1)</script>"])
      id[name] = (await upsertPerson(db, { tenantId: T, aadObjectId: `aad-${name}`, name })).id;
    id.Zed = (await upsertPerson(db, { tenantId: "tenant-2", aadObjectId: "aad-Zed", name: "Zed" })).id;
    await setRole(db, T, id.Ann, "admin");
    sales = (await createDepartment(db, T, "Sales")).id;
    eng = (await createDepartment(db, T, "Engineering")).id;
    foreignDept = (await createDepartment(db, "tenant-2", "Elsewhere")).id;
    await setMembership(db, T, sales, id.Hal, "head");
    await setMembership(db, T, sales, id.Mo, "member");
    await setMembership(db, T, sales, id["<script>alert(1)</script>"], "member");
    await setMembership(db, T, eng, id.Eve, "head");
    const app = express();
    app.use("/admin", adminRouter({ db, config, exchangeCode: async () => ({ id_token: "x" }), verifyIdToken: async () => ({ oid: "", tid: "", name: "", email: "" }), botName: "Bot", defaultModel: "m", fetchUsers: () => directory() }));
    ({ url, close } = await serve(app));
  });
  afterAll(() => close());

  const as = (name: string) => sessionCookie(secretsKey, T, id[name]);
  const get = (path: string, who: string) => fetch(url + path, { redirect: "manual", headers: { cookie: as(who) } });
  const post = (path: string, who: string, body: Record<string, string>) =>
    fetch(url + path, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: as(who) },
      body: new URLSearchParams({ csrf: "csrf-1", ...body }).toString(),
    });
  const person = async (pid: string) => (await listPeople(db, T)).find((p) => p.id === pid)!;
  const members = async (dept: string) => (await listDepartments(db, T)).find((d) => d.id === dept)!.members;

  it("an admin sees the whole roster with role and personal-bot forms", async () => {
    const res = await get("/admin/people", "Ann");
    expect(res.status).toBe(200);
    const body = await res.text();
    for (const name of ["Ann", "Hal", "Mo", "Ola", "Eve"]) expect(body).toContain(`<td>${name}</td>`);
    expect(body).not.toContain("Zed");
    expect(body).toContain(`action="/admin/people/${id.Mo}/role"`);
    expect(body).toContain(`action="/admin/people/${id.Mo}/personal-bot"`);
    expect(body).toContain('name="csrf" value="csrf-1"');
  });

  it("escapes a person's name", async () => {
    const body = await (await get("/admin/people", "Ann")).text();
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    const depts = await (await get("/admin/departments", "Ann")).text();
    expect(depts).not.toContain("<script>alert(1)</script>");
  });

  it("a head sees only people and departments they head, without role forms", async () => {
    const people = await (await get("/admin/people", "Hal")).text();
    expect(people).toContain("<td>Mo</td>");
    expect(people).not.toContain("<td>Ola</td>");
    expect(people).not.toContain("<td>Eve</td>");
    expect(people).not.toContain("/role");
    await setMembership(db, T, eng, id.Mo, "member");
    const shared = await (await get("/admin/people", "Hal")).text();
    await setMembership(db, T, eng, id.Mo, "none");
    expect(shared).toContain("<td>Sales</td>");
    expect(shared).not.toContain("Engineering");
    expect(await (await get("/admin/people", "Ann")).text()).toContain("Engineering");
    const depts = await (await get("/admin/departments", "Hal")).text();
    expect(depts).toContain("Sales");
    expect(depts).not.toContain("Engineering");
    expect(depts).not.toContain("/rename");
    expect(depts).not.toContain('value="head"');
  });

  it("an admin changes roles and creates, renames and deletes departments", async () => {
    let res = await post(`/admin/people/${id.Ola}/role`, "Ann", { role: "admin" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/people");
    expect((await person(id.Ola)).role).toBe("admin");
    await post(`/admin/people/${id.Ola}/role`, "Ann", { role: "user" });
    expect((await person(id.Ola)).role).toBe("user");

    res = await post("/admin/departments", "Ann", { name: "Ops" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/departments");
    const ops = (await listDepartments(db, T)).find((d) => d.name === "Ops")!;
    await post(`/admin/departments/${ops.id}/rename`, "Ann", { name: "Operations" });
    expect((await listDepartments(db, T)).find((d) => d.id === ops.id)!.name).toBe("Operations");
    await post(`/admin/departments/${ops.id}/members`, "Ann", { personId: id.Ola, state: "head" });
    expect(await members(ops.id)).toEqual([{ personId: id.Ola, name: "Ola", isHead: true }]);
    await post(`/admin/departments/${ops.id}/delete`, "Ann", {});
    expect((await listDepartments(db, T)).some((d) => d.id === ops.id)).toBe(false);
  });

  it("demoting the only admin shows the directory message and keeps the role", async () => {
    const res = await post(`/admin/people/${id.Ann}/role`, "Ann", { role: "user" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Keep at least one admin");
    expect((await person(id.Ann)).role).toBe("admin");
  });

  it("rejects invalid input with 400", async () => {
    expect((await post(`/admin/people/${id.Mo}/role`, "Ann", { role: "owner" })).status).toBe(400);
    expect((await post(`/admin/departments/${sales}/members`, "Ann", { personId: id.Ola, state: "boss" })).status).toBe(400);
    expect((await post("/admin/departments", "Ann", { name: "  " })).status).toBe(400);
  });

  it("a head manages members of their own department only", async () => {
    let res = await post(`/admin/departments/${sales}/members`, "Hal", { personId: id.Ola, state: "member" });
    expect(res.status).toBe(303);
    expect((await members(sales)).some((m) => m.personId === id.Ola)).toBe(true);
    await post(`/admin/departments/${sales}/members`, "Hal", { personId: id.Ola, state: "none" });
    expect((await members(sales)).some((m) => m.personId === id.Ola)).toBe(false);

    res = await post(`/admin/departments/${eng}/members`, "Hal", { personId: id.Ola, state: "member" });
    expect(res.status).toBe(403);
    expect((await members(eng)).some((m) => m.personId === id.Ola)).toBe(false);
  });

  it("a head cannot add another tenant's person or touch another tenant's department", async () => {
    const res = await post(`/admin/departments/${sales}/members`, "Hal", { personId: id.Zed, state: "member" });
    expect(res.status).toBe(400);
    expect((await members(sales)).some((m) => m.personId === id.Zed)).toBe(false);
    expect((await post(`/admin/departments/${foreignDept}/members`, "Hal", { personId: id.Mo, state: "member" })).status).toBe(403);
    expect((await post(`/admin/departments/${foreignDept}/members`, "Ann", { personId: id.Mo, state: "member" })).status).toBe(400);
  });

  it("a head cannot set head, change roles, rename, delete or create", async () => {
    expect((await post(`/admin/departments/${sales}/members`, "Hal", { personId: id.Mo, state: "head" })).status).toBe(403);
    expect((await members(sales)).find((m) => m.personId === id.Mo)!.isHead).toBe(false);
    expect((await post(`/admin/people/${id.Mo}/role`, "Hal", { role: "admin" })).status).toBe(403);
    expect((await person(id.Mo)).role).toBe("user");
    expect((await post(`/admin/departments/${sales}/rename`, "Hal", { name: "Mine" })).status).toBe(403);
    expect((await post(`/admin/departments/${sales}/delete`, "Hal", {})).status).toBe(403);
    expect((await post("/admin/departments", "Hal", { name: "New" })).status).toBe(403);
    expect((await listDepartments(db, T)).map((d) => d.name)).toEqual(["Engineering", "Sales"]);
  });

  it("a head cannot modify their own row or another head's", async () => {
    expect((await post(`/admin/departments/${sales}/members`, "Hal", { personId: id.Hal, state: "member" })).status).toBe(403);
    expect((await post(`/admin/departments/${sales}/members`, "Hal", { personId: id.Hal, state: "none" })).status).toBe(403);
    expect((await members(sales)).find((m) => m.personId === id.Hal)!.isHead).toBe(true);
    expect((await post(`/admin/people/${id.Hal}/personal-bot`, "Hal", { personalBot: "on" })).status).toBe(403);
    expect((await person(id.Hal)).personalBot).toBe(false);
    await setMembership(db, T, sales, id.Eve, "head");
    expect((await post(`/admin/departments/${sales}/members`, "Hal", { personId: id.Eve, state: "none" })).status).toBe(403);
    expect((await members(sales)).find((m) => m.personId === id.Eve)!.isHead).toBe(true);
    await setMembership(db, T, sales, id.Eve, "none");
  });

  it("a head sets personal bot for their department's people only", async () => {
    let res = await post(`/admin/people/${id.Mo}/personal-bot`, "Hal", { personalBot: "on" });
    expect(res.status).toBe(303);
    expect((await person(id.Mo)).personalBot).toBe(true);
    res = await post(`/admin/people/${id.Mo}/personal-bot`, "Hal", {});
    expect((await person(id.Mo)).personalBot).toBe(false);

    res = await post(`/admin/people/${id.Ola}/personal-bot`, "Hal", { personalBot: "on" });
    expect(res.status).toBe(403);
    expect((await person(id.Ola)).personalBot).toBe(false);
  });

  it("an admin syncs people from the directory and sees the counts", async () => {
    expect(await (await get("/admin/people", "Ann")).text()).toContain('action="/admin/people/sync"');
    directory = async () => [{ id: "aad-Ola", displayName: "Ola N", mail: "ola@example.test", userPrincipalName: "ola@example.test", accountEnabled: true, userType: "Member" }, { id: "aad-New", displayName: "Newt", mail: null, userPrincipalName: "newt@example.test", accountEnabled: true, userType: "Member" }];
    const res = await post("/admin/people/sync", "Ann", {});
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/people?synced=1,1");
    const body = await (await get("/admin/people?synced=1,1", "Ann")).text();
    expect(body).toContain("Added 1, updated 1.");
    expect(body).toContain("<td>Newt</td>");
    expect(await (await get("/admin/people?synced=<b>,2", "Ann")).text()).not.toContain("Added");
    expect(await (await get("/admin/people", "Ann")).text()).not.toContain("Added");
  });

  it("only an admin with a valid csrf token may sync", async () => {
    expect(await (await get("/admin/people", "Hal")).text()).not.toContain("/people/sync");
    expect((await post("/admin/people/sync", "Hal", {})).status).toBe(403);
    expect((await post("/admin/people/sync", "Ann", { csrf: "wrong" })).status).toBe(403);
  });

  it("a failed sync answers 502 without the error text", async () => {
    directory = async () => { throw new Error("Directory sync failed: 401 sekrit"); };
    const res = await post("/admin/people/sync", "Ann", {});
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain("Directory sync failed.");
    expect(body).not.toContain("sekrit");
  });
});
