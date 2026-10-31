import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { testDb } from "../db/test-db.js";
import type { Db } from "../db/client.js";
import { definitionDepartments } from "../db/schema.js";
import { upsertDefinition } from "../bots/definitions.js";
import { DirectoryError, createDepartment, deleteDepartment, setMembership, setRole } from "../org/directory.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { isAdmin, loadActor, mayEditPersona, mayEnter, mayManageDepartment, mayManagePerson, mayUseDefinition } from "./access.js";
import type { Actor } from "./access.js";

describe("access", () => {
  let db: Db;
  let admin: Actor, head: Actor, user: Actor;
  let depA: string, depB: string, inA: string, inB: string, open: string, restricted: string;
  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: "t1" });
    const mk = (name: string) => upsertPerson(db, { tenantId: "t1", aadObjectId: name, name }).then((p) => p.id);
    const [adminId, headId, userId] = [await mk("admin"), await mk("head"), await mk("user")];
    inA = await mk("inA");
    inB = await mk("inB");
    depA = (await createDepartment(db, "t1", "A")).id;
    depB = (await createDepartment(db, "t1", "B")).id;
    await setRole(db, "t1", adminId, "admin");
    await setMembership(db, "t1", depA, headId, "head");
    await setMembership(db, "t1", depA, inA, "member");
    await setMembership(db, "t1", depB, inB, "member");
    admin = (await loadActor(db, "t1", adminId))!;
    head = (await loadActor(db, "t1", headId))!;
    user = (await loadActor(db, "t1", userId))!;
    const key = Buffer.alloc(32);
    open = (await upsertDefinition(db, key, "t1", { name: "open", label: "Open", persona: "" })).id;
    restricted = (await upsertDefinition(db, key, "t1", { name: "restricted", label: "Restricted", persona: "" })).id;
    await db.insert(definitionDepartments).values({ definitionId: restricted, departmentId: depA });
  });

  it("loads actors", async () => {
    expect(head).toMatchObject({ role: "user", headOf: [depA] });
    expect(await loadActor(db, "other", head.personId)).toBeUndefined();
    expect(await loadActor(db, "t1", "nope")).toBeUndefined();
  });

  it("gates entry and department management", () => {
    expect([isAdmin(admin), isAdmin(head), isAdmin(user)]).toEqual([true, false, false]);
    expect([mayEnter(admin), mayEnter(head), mayEnter(user)]).toEqual([true, true, false]);
    expect([mayManageDepartment(admin, depB), mayManageDepartment(head, depA), mayManageDepartment(head, depB), mayManageDepartment(user, depA)]).toEqual([true, true, false, false]);
  });

  it("gates people and personas", async () => {
    expect([await mayManagePerson(db, admin, inB), await mayManagePerson(db, head, inA), await mayManagePerson(db, head, inB), await mayManagePerson(db, user, inA)]).toEqual([true, true, false, false]);
    expect([await mayEditPersona(db, admin, open), await mayEditPersona(db, head, restricted), await mayEditPersona(db, head, open), await mayEditPersona(db, user, restricted)]).toEqual([true, true, false, false]);
  });

  it("keeps restricted definitions restricted when their department is deleted", async () => {
    await expect(deleteDepartment(db, "t1", depA)).rejects.toThrow(new DirectoryError("Remove it from bots first"));
    expect(await mayUseDefinition(db, "t1", inB, restricted)).toBe(false);
    const d = await createDepartment(db, "t1", "Tmp");
    const key = Buffer.alloc(32);
    const def = (await upsertDefinition(db, key, "t1", { name: "tmp", label: "Tmp", persona: "" })).id;
    await db.insert(definitionDepartments).values({ definitionId: def, departmentId: d.id });
    await expect(deleteDepartment(db, "t1", d.id)).rejects.toThrow("Remove it from bots first");
    await db.delete(definitionDepartments).where(eq(definitionDepartments.definitionId, def));
    await deleteDepartment(db, "t1", d.id);
  });

  it("rejects ids from another tenant for admin and head actors", async () => {
    await upsertTenant(db, { id: "t2" });
    const foreign = (await upsertPerson(db, { tenantId: "t2", aadObjectId: "f", name: "F" })).id;
    const foreignDef = (await upsertDefinition(db, Buffer.alloc(32), "t2", { name: "fd", label: "FD", persona: "" })).id;
    for (const a of [admin, head]) {
      expect(await mayManagePerson(db, a, foreign)).toBe(false);
      expect(await mayEditPersona(db, a, foreignDef)).toBe(false);
    }
    expect(await mayUseDefinition(db, "t1", admin.personId, foreignDef)).toBe(false);
  });

  it("gates definition use", async () => {
    expect(await mayUseDefinition(db, "t1", user.personId, open)).toBe(true);
    expect(await mayUseDefinition(db, "t1", user.personId, restricted)).toBe(false);
    expect(await mayUseDefinition(db, "t1", inA, restricted)).toBe(true);
    expect(await mayUseDefinition(db, "t1", inB, restricted)).toBe(false);
    expect(await mayUseDefinition(db, "t1", admin.personId, restricted)).toBe(true);
  });
});
