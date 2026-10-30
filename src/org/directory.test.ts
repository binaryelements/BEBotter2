import { beforeAll, describe, expect, it } from "vitest";
import { testDb } from "../db/test-db.js";
import type { Db } from "../db/client.js";
import { upsertPerson, upsertTenant } from "./org.js";
import {
  DirectoryError, createDepartment, deleteDepartment, listDepartments, listPeople, renameDepartment,
  setAdminFromEmail, setMembership, setPersonalBot, setRole,
} from "./directory.js";

const person = (db: Db, tenantId: string, name: string) => upsertPerson(db, { tenantId, aadObjectId: `aad-${tenantId}-${name}`, name });
const rejects = (p: Promise<unknown>) => expect(p).rejects.toThrow(new DirectoryError("Not found"));

describe("directory", () => {
  let db: Db;
  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: "t1" });
    await upsertTenant(db, { id: "t2" });
  });

  it("refuses to demote the last admin, allows self-demotion with two", async () => {
    const a = await person(db, "t1", "Ann");
    const b = await person(db, "t1", "Bob");
    await setRole(db, "t1", a.id, "admin");
    await expect(setRole(db, "t1", a.id, "user")).rejects.toThrow("Keep at least one admin");
    await setRole(db, "t1", b.id, "admin");
    await setRole(db, "t1", a.id, "user");
    const rows = await listPeople(db, "t1");
    expect(rows.map((r) => [r.name, r.role])).toEqual([["Ann", "user"], ["Bob", "admin"]]);
  });

  it("rejects ids from another tenant in every mutator", async () => {
    const other = await person(db, "t2", "Zed");
    const dept = await createDepartment(db, "t2", "Other");
    await rejects(setRole(db, "t1", other.id, "admin"));
    await rejects(setPersonalBot(db, "t1", other.id, true));
    await rejects(setAdminFromEmail(db, "t1", other.id, "z@x.io", []));
    await rejects(renameDepartment(db, "t1", dept.id, "X"));
    await rejects(deleteDepartment(db, "t1", dept.id));
    await rejects(setMembership(db, "t1", dept.id, other.id, "member"));
    const mine = await person(db, "t1", "Mine");
    await rejects(setMembership(db, "t1", dept.id, mine.id, "member"));
    expect(await listDepartments(db, "t1")).toEqual([]);
  });

  it("moves a membership member -> head -> none", async () => {
    const d = await createDepartment(db, "t1", "Sales");
    const p = await person(db, "t1", "Cat");
    await setMembership(db, "t1", d.id, p.id, "member");
    expect((await listDepartments(db, "t1"))[0].members).toEqual([{ personId: p.id, name: "Cat", isHead: false }]);
    await setMembership(db, "t1", d.id, p.id, "head");
    expect((await listDepartments(db, "t1"))[0].members[0].isHead).toBe(true);
    expect((await listPeople(db, "t1")).find((r) => r.id === p.id)!.memberships).toEqual([{ departmentId: d.id, departmentName: "Sales", isHead: true }]);
    await setMembership(db, "t1", d.id, p.id, "none");
    expect((await listDepartments(db, "t1"))[0].members).toEqual([]);
    await renameDepartment(db, "t1", d.id, "Revenue");
    expect((await listDepartments(db, "t1"))[0].name).toBe("Revenue");
    await deleteDepartment(db, "t1", d.id);
    expect(await listDepartments(db, "t1")).toEqual([]);
  });

  it("promotes listed emails case-insensitively and never demotes", async () => {
    const x = await person(db, "t1", "Xia");
    const y = await person(db, "t1", "Yan");
    await setAdminFromEmail(db, "t1", x.id, "Xia@Corp.io", ["xia@corp.io"]);
    await setAdminFromEmail(db, "t1", y.id, "yan@corp.io", ["xia@corp.io"]);
    await setAdminFromEmail(db, "t1", x.id, "xia@corp.io", []);
    const rows = await listPeople(db, "t1");
    const get = (id: string) => rows.find((r) => r.id === id)!;
    expect([get(x.id).role, get(x.id).email]).toEqual(["admin", "xia@corp.io"]);
    expect([get(y.id).role, get(y.id).email]).toEqual(["user", "yan@corp.io"]);
    await setPersonalBot(db, "t1", y.id, true);
    expect(get(y.id).personalBot).toBe(false);
    expect((await listPeople(db, "t1")).find((r) => r.id === y.id)!.personalBot).toBe(true);
  });
});
