import { beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { assignToChat, upsertDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { testDb } from "../db/test-db.js";
import { DirectoryError, setRole } from "../org/directory.js";
import { getTenantSettings, setTenantSettings, upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { claimDue, createRoutine, deleteRoutine, listRoutines, updateRoutine } from "./store.js";

describe("routines store", () => {
  let db: Db;
  let defId: string;
  let adminId: string;
  let userId: string;
  const base = () => ({ definitionId: defId, chatId: "c1", prompt: "check backups", createdByPersonId: userId });
  beforeEach(async () => {
    db = await testDb();
    await upsertTenant(db, { id: "t1" });
    defId = (await upsertDefinition(db, randomBytes(32), "t1", { name: "ops", label: "Ops", persona: "p" })).id;
    await upsertChat(db, { id: "c1", tenantId: "t1", conversationType: "groupChat" });
    await upsertChat(db, { id: "c2", tenantId: "t1", conversationType: "groupChat" });
    await assignToChat(db, "c1", defId);
    adminId = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "a1", name: "Ann" })).id;
    userId = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "a2", name: "Bob" })).id;
    await setRole(db, "t1", adminId, "admin");
  });

  it("claimDue runs a cron routine once per matching minute", async () => {
    const r = await createRoutine(db, "t1", { ...base(), schedule: "0 7 * * *" });
    expect(await claimDue(db, new Date("2026-10-26T06:59:00Z"))).toEqual([]);
    expect((await claimDue(db, new Date("2026-10-26T07:00:20Z"))).map((x) => x.id)).toEqual([r.id]);
    expect(await claimDue(db, new Date("2026-10-26T07:00:40Z"))).toEqual([]);
    expect(await claimDue(db, new Date("2026-10-27T07:00:00Z"))).toHaveLength(1);
  });

  it("claimDue uses the tenant time zone", async () => {
    await setTenantSettings(db, "t1", { ...(await getTenantSettings(db, "t1")), timezone: "Australia/Sydney" });
    await createRoutine(db, "t1", { ...base(), schedule: "0 7 * * *" });
    expect(await claimDue(db, new Date("2026-10-29T07:00:00Z"))).toEqual([]);
    expect(await claimDue(db, new Date("2026-10-29T20:00:00Z"))).toHaveLength(1);
  });

  it("two concurrent claimDue calls claim a routine once", async () => {
    await createRoutine(db, "t1", { ...base(), schedule: "* * * * *" });
    const now = new Date("2026-10-26T07:00:00Z");
    const [a, b] = await Promise.all([claimDue(db, now), claimDue(db, now)]);
    expect(a.length + b.length).toBe(1);
  });

  it("one-off routine runs once and is disabled", async () => {
    const r = await createRoutine(db, "t1", { ...base(), runAt: new Date(Date.now() + 60_000) });
    expect(await claimDue(db, new Date())).toEqual([]);
    const later = new Date(Date.now() + 120_000);
    expect((await claimDue(db, later)).map((x) => x.id)).toEqual([r.id]);
    expect(await claimDue(db, new Date(later.getTime() + 120_000))).toEqual([]);
    expect((await listRoutines(db, "t1"))[0].enabled).toBe(false);
  });

  it("a disabled routine is never claimed", async () => {
    const r = await createRoutine(db, "t1", { ...base(), schedule: "* * * * *" });
    await updateRoutine(db, "t1", r.id, { enabled: false });
    expect(await claimDue(db, new Date())).toEqual([]);
  });

  it("createRoutine refuses an unassigned chat, a past runAt, a bad schedule and a non-admin grant", async () => {
    await expect(createRoutine(db, "t1", { ...base(), chatId: "c2", schedule: "* * * * *" })).rejects.toThrow("not assigned");
    await expect(createRoutine(db, "t1", { ...base(), runAt: new Date(Date.now() - 1000) })).rejects.toThrow("future");
    await expect(createRoutine(db, "t1", { ...base(), schedule: "* * *" })).rejects.toThrow("5 fields");
    await expect(createRoutine(db, "t1", { ...base() })).rejects.toThrow("exactly one");
    await expect(createRoutine(db, "t1", { ...base(), schedule: "* * * * *", grantPersonId: userId })).rejects.toThrow("admin");
    await expect(createRoutine(db, "t2", { ...base(), schedule: "* * * * *" })).rejects.toThrow("not assigned");
    expect(await listRoutines(db, "t1")).toEqual([]);
    expect((await createRoutine(db, "t1", { ...base(), schedule: "* * * * *", grantPersonId: adminId })).grantPersonId).toBe(adminId);
  });

  it("updates and deletes are tenant scoped", async () => {
    const r = await createRoutine(db, "t1", { ...base(), schedule: "* * * * *" });
    await expect(updateRoutine(db, "t2", r.id, { quiet: true })).rejects.toThrow("No such");
    expect((await updateRoutine(db, "t1", r.id, { quiet: true })).quiet).toBe(true);
    await expect(deleteRoutine(db, "t2", r.id)).rejects.toThrow("No such");
    await deleteRoutine(db, "t1", r.id);
    expect(await listRoutines(db, "t1")).toEqual([]);
  });

  it("updateRoutine refuses an empty or bad schedule and leaves the routine unchanged", async () => {
    const r = await createRoutine(db, "t1", { ...base(), schedule: "0 7 * * *" });
    for (const bad of ["", "nope"]) await expect(updateRoutine(db, "t1", r.id, { schedule: bad })).rejects.toThrow(DirectoryError);
    expect((await listRoutines(db, "t1"))[0].schedule).toBe("0 7 * * *");
  });

  describe("daylight saving (schedules are local wall-clock time)", () => {
    beforeEach(async () => {
      await setTenantSettings(db, "t1", { ...(await getTenantSettings(db, "t1")), timezone: "America/New_York" });
    });
    it("a time that does not exist is skipped on spring-forward day", async () => {
      await createRoutine(db, "t1", { ...base(), schedule: "30 2 * * *" });
      // 2026-03-08: 02:00 EST -> 03:00 EDT, so 02:30 never happens
      for (const iso of ["2026-03-08T06:30:00Z", "2026-03-08T07:30:00Z", "2026-03-08T08:30:00Z"]) expect(await claimDue(db, new Date(iso))).toEqual([]);
      expect(await claimDue(db, new Date("2026-03-09T06:30:00Z"))).toHaveLength(1); // 02:30 EDT next day
    });
    it("a repeated time runs once on fall-back day", async () => {
      await createRoutine(db, "t1", { ...base(), schedule: "30 1 * * *" });
      // 2026-11-01: 01:30 EDT (05:30Z) then 01:30 EST (06:30Z)
      expect(await claimDue(db, new Date("2026-11-01T05:30:00Z"))).toHaveLength(1);
      expect(await claimDue(db, new Date("2026-11-01T06:30:00Z"))).toEqual([]);
      expect(await claimDue(db, new Date("2026-11-02T06:30:00Z"))).toHaveLength(1); // 01:30 EST next day
    });
  });
});
