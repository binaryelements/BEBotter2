import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { testDb } from "../db/test-db.js";
import { createDepartment, setMembership, setRole } from "../org/directory.js";
import { getTenantSettings, upsertPerson, upsertTenant } from "../org/org.js";
import { adminRouter } from "./router.js";
import { serve, sessionCookie } from "./test-server.js";

const secretsKey = Buffer.alloc(32, 5);
const T = "tenant-1";
const config = { teams: { clientId: "c", tenantId: T, clientSecret: "s" }, publicUrl: "https://bot.example.test", adminEmails: [], secretsKey };

describe("settings screen", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  const id: Record<string, string> = {};

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: T });
    for (const name of ["Ann", "Hal"]) id[name] = (await upsertPerson(db, { tenantId: T, aadObjectId: `aad-${name}`, name })).id;
    await setRole(db, T, id.Ann, "admin");
    await setMembership(db, T, (await createDepartment(db, T, "Sales")).id, id.Hal, "head");
    const app = express();
    app.use("/admin", adminRouter({ db, config, exchangeCode: async () => ({ id_token: "x" }), verifyIdToken: async () => ({ oid: "", tid: "", name: "", email: "" }), botName: "Bot", defaultModel: "m", fetchUsers: async () => [] }));
    ({ url, close } = await serve(app));
  });
  afterAll(() => close());

  const get = (who: string) => fetch(url + "/admin/settings", { redirect: "manual", headers: { cookie: sessionCookie(secretsKey, T, id[who]) } });
  const post = (who: string, f: { botName?: string; retentionDays?: string; defaultModel?: string }) =>
    fetch(url + "/admin/settings", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie(secretsKey, T, id[who]) },
      body: new URLSearchParams({ csrf: "csrf-1", botName: "", retentionDays: "90", defaultModel: "", ...f }).toString(),
    });

  it("defaults for a missing tenant", async () => {
    expect(await getTenantSettings(db, "nobody")).toEqual({ botName: null, retentionDays: 90, defaultModel: null });
  });

  it("saves, trims, and stores an empty bot name as null", async () => {
    const r = await post("Ann", { botName: "  Helper  ", retentionDays: "30", defaultModel: " claude-sonnet-5 " });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/admin/settings");
    expect(await getTenantSettings(db, T)).toEqual({ botName: "Helper", retentionDays: 30, defaultModel: "claude-sonnet-5" });
    const page = await (await get("Ann")).text();
    expect(page).toContain('value="Helper"');
    expect(page).toContain('value="30"');
    await post("Ann", { botName: "  ", retentionDays: "30" });
    expect(await getTenantSettings(db, T)).toEqual({ botName: null, retentionDays: 30, defaultModel: null });
  });

  it("rejects bad values and keeps the old ones", async () => {
    for (const f of [{ retentionDays: "0" }, { retentionDays: "3651" }, { retentionDays: "1.5" }, { retentionDays: "x" }, { botName: "x".repeat(41) }, { defaultModel: "gpt-4" }, { defaultModel: "claude-X" }]) {
      expect((await post("Ann", f)).status).toBe(400);
    }
    expect((await getTenantSettings(db, T)).retentionDays).toBe(30);
  });

  it("a head gets 403", async () => {
    expect((await get("Hal")).status).toBe(403);
    expect((await post("Hal", { retentionDays: "5" })).status).toBe(403);
    expect((await getTenantSettings(db, T)).retentionDays).toBe(30);
  });

  it("a definition created without a model takes the tenant default", async () => {
    await post("Ann", { retentionDays: "30", defaultModel: "claude-opus-9" });
    expect((await upsertDefinition(db, secretsKey, T, { name: "x", label: "X", persona: "" })).model).toBe("claude-opus-9");
    expect((await upsertDefinition(db, secretsKey, T, { name: "y", label: "Y", persona: "", model: "claude-z" })).model).toBe("claude-z");
    expect((await upsertDefinition(db, secretsKey, "t-plain", { name: "x", label: "X", persona: "" })).model).toBe("claude-haiku-5-5");
  });
});
