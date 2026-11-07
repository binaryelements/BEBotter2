import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { testDb } from "../db/test-db.js";
import { createDepartment, setMembership, setRole } from "../org/directory.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { adminRouter } from "./router.js";
import { serve, sessionCookie } from "./test-server.js";

const secretsKey = Buffer.alloc(32, 4);
const T = "tenant-1";
const config = { teams: { clientId: "c", tenantId: T, clientSecret: "s" }, publicUrl: "https://bot.example.test", adminEmails: [], secretsKey };

describe("to-dos screen", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  const id: Record<string, string> = {};

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: T });
    for (const name of ["Ann", "Hal", "Mo"]) id[name] = (await upsertPerson(db, { tenantId: T, aadObjectId: `aad-${name}`, name })).id;
    await setRole(db, T, id.Ann, "admin");
    const sales = (await createDepartment(db, T, "Sales")).id;
    await setMembership(db, T, sales, id.Hal, "head");
    await setMembership(db, T, sales, id.Mo, "member");
    const app = express();
    app.use("/admin", adminRouter({ db, config, exchangeCode: async () => ({ id_token: "x" }), verifyIdToken: async () => ({ oid: "", tid: "", name: "", email: "" }), botName: "Bot", defaultModel: "m", fetchUsers: async () => [] }));
    ({ url, close } = await serve(app));
  });
  afterAll(() => close());

  const get = (path: string, who: string) => fetch(url + path, { redirect: "manual", headers: { cookie: sessionCookie(secretsKey, T, id[who]) } });
  const post = (path: string, who: string, body: Record<string, string>) =>
    fetch(url + path, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie(secretsKey, T, id[who]) },
      body: new URLSearchParams({ csrf: "csrf-1", ...body }).toString(),
    });

  it("an admin adds a to-do for a person, marks it done and deletes it", async () => {
    expect((await post("/admin/todos", "Ann", { personId: id.Mo, title: "Send the report", dueAt: "2026-11-10" })).status).toBe(303);
    const open = await (await get(`/admin/todos?person=${id.Mo}`, "Ann")).text();
    expect(open).toContain("Send the report");
    expect(open).toContain("Mo");
    const match = /action="\/admin\/todos\/([0-9a-f-]+)\/done"/.exec(open);
    expect(match).not.toBeNull();
    expect((await post(`/admin/todos/${match![1]}/done`, "Ann", { done: "on" })).status).toBe(303);
    const done = await (await get(`/admin/todos?person=${id.Mo}&status=done`, "Ann")).text();
    expect(done).toContain("Send the report");
    expect((await post(`/admin/todos/${match![1]}/delete`, "Ann", {})).status).toBe(303);
    expect(await (await get(`/admin/todos?person=${id.Mo}&status=all`, "Ann")).text()).not.toContain("Send the report");
  });

  it("refuses a head", async () => {
    expect((await get("/admin/todos", "Hal")).status).toBe(403);
    expect((await post("/admin/todos", "Hal", { personId: id.Mo, title: "x" })).status).toBe(403);
  });
});
