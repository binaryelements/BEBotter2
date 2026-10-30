import { and, asc, count, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { departmentMembers, departments, people } from "../db/schema.js";
import type { Department } from "../db/schema.js";

export class DirectoryError extends Error {}

type Role = "user" | "admin";
export type PersonRow = {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  personalBot: boolean;
  memberships: { departmentId: string; departmentName: string; isHead: boolean }[];
};
export type DepartmentRow = { id: string; name: string; members: { personId: string; name: string; isHead: boolean }[] };

const notFound = () => new DirectoryError("Not found");

async function requirePerson(db: Db, tenantId: string, personId: string): Promise<void> {
  const [row] = await db.select({ id: people.id }).from(people).where(and(eq(people.id, personId), eq(people.tenantId, tenantId)));
  if (!row) throw notFound();
}

async function requireDepartment(db: Db, tenantId: string, id: string): Promise<void> {
  const [row] = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.id, id), eq(departments.tenantId, tenantId)));
  if (!row) throw notFound();
}

export async function listPeople(db: Db, tenantId: string): Promise<PersonRow[]> {
  const rows = await db
    .select({
      person: people,
      departmentId: departments.id,
      departmentName: departments.name,
      isHead: departmentMembers.isHead,
    })
    .from(people)
    .leftJoin(departmentMembers, eq(departmentMembers.personId, people.id))
    .leftJoin(departments, eq(departments.id, departmentMembers.departmentId))
    .where(eq(people.tenantId, tenantId))
    .orderBy(asc(people.name), asc(departments.name));
  const byId = new Map<string, PersonRow>();
  for (const { person, departmentId, departmentName, isHead } of rows) {
    let row = byId.get(person.id);
    if (!row) {
      row = { id: person.id, name: person.name, email: person.email, role: person.role as Role, personalBot: person.personalBot, memberships: [] };
      byId.set(person.id, row);
    }
    if (departmentId) row.memberships.push({ departmentId, departmentName: departmentName!, isHead: isHead! });
  }
  return [...byId.values()];
}

export async function setRole(db: Db, tenantId: string, personId: string, role: Role): Promise<void> {
  await db.transaction(async (tx) => {
    const [target] = await tx.select({ role: people.role }).from(people).where(and(eq(people.id, personId), eq(people.tenantId, tenantId)));
    if (!target) throw notFound();
    if (target.role === "admin" && role === "user") {
      const [{ n }] = await tx
        .select({ n: count() })
        .from(people)
        .where(and(eq(people.tenantId, tenantId), eq(people.role, "admin"), ne(people.id, personId)));
      if (n === 0) throw new DirectoryError("Keep at least one admin");
    }
    await tx.update(people).set({ role }).where(eq(people.id, personId));
  });
}

export async function setPersonalBot(db: Db, tenantId: string, personId: string, on: boolean): Promise<void> {
  const rows = await db.update(people).set({ personalBot: on }).where(and(eq(people.id, personId), eq(people.tenantId, tenantId))).returning({ id: people.id });
  if (rows.length === 0) throw notFound();
}

export async function listDepartments(db: Db, tenantId: string): Promise<DepartmentRow[]> {
  const rows = await db
    .select({ id: departments.id, name: departments.name, personId: people.id, personName: people.name, isHead: departmentMembers.isHead })
    .from(departments)
    .leftJoin(departmentMembers, eq(departmentMembers.departmentId, departments.id))
    .leftJoin(people, eq(people.id, departmentMembers.personId))
    .where(eq(departments.tenantId, tenantId))
    .orderBy(asc(departments.name), asc(people.name));
  const byId = new Map<string, DepartmentRow>();
  for (const r of rows) {
    let row = byId.get(r.id);
    if (!row) {
      row = { id: r.id, name: r.name, members: [] };
      byId.set(r.id, row);
    }
    if (r.personId) row.members.push({ personId: r.personId, name: r.personName!, isHead: r.isHead! });
  }
  return [...byId.values()];
}

export async function createDepartment(db: Db, tenantId: string, name: string): Promise<Department> {
  const [row] = await db.insert(departments).values({ id: crypto.randomUUID(), tenantId, name }).returning();
  return row;
}

export async function renameDepartment(db: Db, tenantId: string, id: string, name: string): Promise<void> {
  const rows = await db.update(departments).set({ name }).where(and(eq(departments.id, id), eq(departments.tenantId, tenantId))).returning({ id: departments.id });
  if (rows.length === 0) throw notFound();
}

export async function deleteDepartment(db: Db, tenantId: string, id: string): Promise<void> {
  const rows = await db.delete(departments).where(and(eq(departments.id, id), eq(departments.tenantId, tenantId))).returning({ id: departments.id });
  if (rows.length === 0) throw notFound();
}

export async function setMembership(
  db: Db,
  tenantId: string,
  departmentId: string,
  personId: string,
  state: "none" | "member" | "head",
): Promise<void> {
  await requireDepartment(db, tenantId, departmentId);
  await requirePerson(db, tenantId, personId);
  if (state === "none") {
    await db.delete(departmentMembers).where(and(eq(departmentMembers.departmentId, departmentId), eq(departmentMembers.personId, personId)));
    return;
  }
  const isHead = state === "head";
  await db
    .insert(departmentMembers)
    .values({ departmentId, personId, isHead })
    .onConflictDoUpdate({ target: [departmentMembers.departmentId, departmentMembers.personId], set: { isHead } });
}

export async function setAdminFromEmail(db: Db, tenantId: string, personId: string, email: string, adminEmails: string[]): Promise<void> {
  const lower = email.toLowerCase();
  const promote = adminEmails.some((e) => e.toLowerCase() === lower);
  const rows = await db
    .update(people)
    .set(promote ? { email: lower, role: "admin" } : { email: lower })
    .where(and(eq(people.id, personId), eq(people.tenantId, tenantId)))
    .returning({ id: people.id });
  if (rows.length === 0) throw notFound();
}
