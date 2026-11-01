import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertDefinition, setAllowedDepartments } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { createDepartment, setMembership, setRole } from "../org/directory.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { localStart } from "./overview.js";
import { adminRouter } from "./router.js";
import { serve, sessionCookie } from "./test-server.js";

const secretsKey = Buffer.alloc(32, 7);
const T = "tenant-1";
const config = { teams: { clientId: "c", tenantId: T, clientSecret: "s" }, publicUrl: "https://bot.example.test", adminEmails: [], secretsKey };

describe("overview", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  const id: Record<string, string> = {};

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: T });
    for (const n of ["Ann", "Hal"]) id[n] = (await upsertPerson(db, { tenantId: T, aadObjectId: `aad-${n}`, name: n })).id;
    await setRole(db, T, id.Ann, "admin");
    const sales = (await createDepartment(db, T, "Sales")).id;
    await setMembership(db, T, sales, id.Hal, "head");
    const mk = async (name: string, label: string) => (await upsertDefinition(db, secretsKey, T, { name, label, persona: "p", model: "m1" } as Parameters<typeof upsertDefinition>[3])).id;
    const a = await mk("alpha", "Sales helper");
    const b = await mk("beta", "Secret ops");
    await setAllowedDepartments(db, T, a, [sales]);
    const now = new Date();
    const at = (s: number) => new Date(now.getTime() + s * 1000).toISOString();
    const row = (n: number, def: string, over: Partial<typeof auditEvents.$inferInsert>) =>
      ({ id: `ev${n}`, tenantId: T, definitionId: def, personId: id.Hal, kind: "tool", summary: "x", status: "done", startedAt: now, ...over }) as typeof auditEvents.$inferInsert;
    await db.insert(auditEvents).values([
      row(1, a, { toolName: "send_email", summary: "Send the quarterly mail", status: "pending" }),
      row(2, a, { kind: "message", summary: "m", costUsd: "1.250000", timings: { receivedAt: at(0), sentAt: at(2), tools: 0 } }),
      row(3, a, { kind: "message", summary: "m", costUsd: "0.500000", timings: { receivedAt: at(0), sentAt: at(6), tools: 0 } }),
      row(5, a, { toolName: "old_tool", summary: "Orphaned long ago", status: "pending", startedAt: new Date(now.getTime() - 30 * 60_000) }),
      row(4, b, { toolName: "secret_tool", summary: "Beta private job", status: "pending" }),
    ]);
    const app = express();
    app.use("/admin", adminRouter({ db, config, exchangeCode: async () => ({ id_token: "x" }), verifyIdToken: async () => ({ oid: "", tid: "", name: "", email: "" }), botName: "Bot", defaultModel: "m", fetchUsers: async () => [] }));
    ({ url, close } = await serve(app));
  });
  afterAll(() => close());

  const get = (path: string, who: string) => fetch(url + path, { redirect: "manual", headers: { cookie: sessionCookie(secretsKey, T, id[who]) } });

  it("an admin sees tiles with the seeded values, a pending notice and every bot", async () => {
    const res = await get("/admin", "Ann");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain('<div class="be-eyebrow">bots</div><div class="v">2</div>');
    expect(page).toContain('waiting approvals</div><div class="v">2</div>');
    expect(page).toContain('median reply time</div><div class="v">4.0 s</div>');
    expect(page).toContain('spend this month</div><div class="v">$1.75</div>');
    expect(page).toContain("is waiting for approval: Send the quarterly mail");
    expect(page).not.toContain("is waiting for approval: Orphaned long ago"); // pending for over 10 minutes: no longer approvable, not counted
    expect(page).not.toContain("<button class=\"be-btn primary\">approve");
    expect(page).toContain("Secret ops");
    expect(page).toContain('aria-current="page">Overview</a>');
    expect((await (await get("/admin/overview", "Ann")).text())).toContain("waiting approvals");
  });

  it("a head sees only their departments' bots and their numbers", async () => {
    const page = await (await get("/admin", "Hal")).text();
    expect(page).toContain("Sales helper");
    expect(page).not.toContain("Secret ops");
    expect(page).not.toContain("Beta private job");
    expect(page).toContain('<div class="be-eyebrow">bots</div><div class="v">1</div>');
    expect(page).toContain('waiting approvals</div><div class="v">1</div>');
    expect(page).not.toMatch(/bam_|amwh_/);
  });
});

describe("local day and month", () => {
  it("start at local midnight in the tenant's zone, not UTC", () => {
    const now = new Date("2026-10-31T20:00:00Z"); // 07:00 on 1 November in Sydney
    expect(localStart(now, "Australia/Sydney", "day").toISOString()).toBe("2026-10-31T13:00:00.000Z");
    expect(localStart(now, "Australia/Sydney", "month").toISOString()).toBe("2026-10-31T13:00:00.000Z");
    expect(localStart(now, "UTC", "month").toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(localStart(now, "America/Los_Angeles", "day").toISOString()).toBe("2026-10-31T07:00:00.000Z");
  });
});
