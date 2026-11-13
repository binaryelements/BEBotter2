import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assignToChat, upsertDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { routines } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { eq } from "drizzle-orm";
import { createDepartment, setMembership, setRole } from "../org/directory.js";
import { upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { createRoutine, listRoutines } from "../routines/store.js";
import { adminRouter } from "./router.js";
import { serve, sessionCookie } from "./test-server.js";

const secretsKey = Buffer.alloc(32, 7);
const T = "tenant-1";
const MODEL = "deepseek/deepseek-flash";
const config = { teams: { clientId: "c", tenantId: T, clientSecret: "s" }, publicUrl: "https://bot.example.test", adminEmails: [], secretsKey };

describe("routines screen", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  let id: Record<string, string>;
  let botId: string;
  let routineId: string;

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: T });
    id = {};
    for (const name of ["Ann", "Hal"]) id[name] = (await upsertPerson(db, { tenantId: T, aadObjectId: `aad-${name}`, name })).id;
    await setRole(db, T, id.Ann, "admin");
    await setMembership(db, T, (await createDepartment(db, T, "Sales")).id, id.Hal, "head");
    botId = (await upsertDefinition(db, secretsKey, T, { name: "ops", label: "Ops", persona: "p", model: MODEL })).id;
    await upsertChat(db, { id: "c1", tenantId: T, conversationType: "groupChat", name: "Ops room" });
    await assignToChat(db, "c1", botId);
    routineId = (await createRoutine(db, T, { definitionId: botId, chatId: "c1", prompt: "sweep the fleet", schedule: "0 7 * * *", createdByPersonId: id.Ann })).id;
    const app = express();
    app.use(
      "/admin",
      adminRouter({
        db,
        config,
        exchangeCode: async () => ({ id_token: "x" }),
        verifyIdToken: async () => ({ oid: "", tid: "", name: "", email: "" }),
        botName: "Bot",
        defaultModel: MODEL,
        models: [MODEL],
        runTurn: async () => ({ text: "ok", costUsd: 0, changed: false, timings: { receivedAt: new Date().toISOString(), tools: 0 }, auditId: "a" }),
        fetchUsers: async () => [],
      }),
    );
    ({ url, close } = await serve(app));
  });
  afterAll(() => close());

  const get = (path: string, who: string) => fetch(url + path, { redirect: "manual", headers: { cookie: sessionCookie(secretsKey, T, id[who]) } });
  const post = (path: string, who: string) =>
    fetch(url + path, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie(secretsKey, T, id[who]) },
      body: new URLSearchParams({ csrf: "csrf-1" }).toString(),
    });
  const row = async () => (await db.select().from(routines).where(eq(routines.id, routineId)))[0];

  it("lists every routine with its bot, chat, schedule and state", async () => {
    const page = await (await get("/admin/routines", "Ann")).text();
    expect(page).toContain("sweep the fleet");
    expect(page).toContain("Ops");
    expect(page).toContain("Ops room");
    expect(page).toContain("every day 7:00 am");
    expect(page).toContain("scheduled");
    // a head of the bot's department sees it too, without the buttons
    const head = await (await get("/admin/routines", "Hal")).text();
    expect(head).toContain("sweep the fleet");
    expect(head).not.toContain(`/admin/routines/${routineId}/run`);
  });

  it("pauses, runs now, and deletes as an admin; a head may not", async () => {
    expect((await post(`/admin/routines/${routineId}/enabled`, "Hal")).status).toBe(403);
    expect((await post(`/admin/routines/${routineId}/enabled`, "Ann")).status).toBe(303);
    expect((await row()).enabled).toBe(false);

    expect((await post(`/admin/routines/${routineId}/run`, "Ann")).status).toBe(303);
    const after = await row();
    expect(after.enabled).toBe(true);
    expect(after.runAt).toBeTruthy();
    expect(after.lastRunAt).toBeNull();

    expect((await post(`/admin/routines/${routineId}/delete`, "Ann")).status).toBe(303);
    expect(await listRoutines(db, T)).toEqual([]);
  });
});
