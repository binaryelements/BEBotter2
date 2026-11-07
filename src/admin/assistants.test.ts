import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensurePersonalAssistant } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { testDb } from "../db/test-db.js";
import { createDepartment, setMembership, setPersonalBot, setRole } from "../org/directory.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { adminRouter } from "./router.js";
import { serve, sessionCookie } from "./test-server.js";

const secretsKey = Buffer.alloc(32, 3);
const T = "tenant-1";
const config = { teams: { clientId: "c", tenantId: T, clientSecret: "s" }, publicUrl: "https://bot.example.test", adminEmails: [], secretsKey };

describe("personal assistants screen", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  const id: Record<string, string> = {};
  let pa: string;

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: T });
    for (const name of ["Ann", "Hal", "Mo", "Ola"]) id[name] = (await upsertPerson(db, { tenantId: T, aadObjectId: `aad-${name}`, name })).id;
    await setRole(db, T, id.Ann, "admin");
    const sales = (await createDepartment(db, T, "Sales")).id;
    await setMembership(db, T, sales, id.Hal, "head");
    await setMembership(db, T, sales, id.Mo, "member");
    await setPersonalBot(db, T, id.Mo, true);
    pa = (await ensurePersonalAssistant(db, T, id.Mo, "m")).id;
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

  it("lists each assistant with its owner, and only admins may open it", async () => {
    const page = await (await get("/admin/assistants", "Ann")).text();
    expect(page).toContain("Personal assistants");
    expect(page).toContain("for Mo");
    expect(page).toContain("My assistant");
    expect((await get("/admin/assistants", "Hal")).status).toBe(403);
  });

  it("turns an assistant off and on from its card", async () => {
    expect((await post(`/admin/assistants/${pa}/enabled`, "Ann", {})).status).toBe(303);
    const off = await (await get("/admin/assistants", "Ann")).text();
    expect(off).toContain("off");
    expect((await post(`/admin/assistants/${pa}/enabled`, "Ann", { enabled: "on" })).status).toBe(303);
    const on = await (await get("/admin/assistants", "Ann")).text();
    expect(on).toContain("on");
  });
});
