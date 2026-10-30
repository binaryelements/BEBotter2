import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { definitionDepartments, departmentMembers, departments, people } from "../db/schema.js";

export type Actor = { personId: string; tenantId: string; name: string; role: "user" | "admin"; headOf: string[] };

export async function loadActor(db: Db, tenantId: string, personId: string): Promise<Actor | undefined> {
  const [p] = await db.select().from(people).where(and(eq(people.id, personId), eq(people.tenantId, tenantId)));
  if (!p) return undefined;
  const heads = await db
    .select({ id: departmentMembers.departmentId })
    .from(departmentMembers)
    .where(and(eq(departmentMembers.personId, personId), eq(departmentMembers.isHead, true)));
  return { personId, tenantId, name: p.name, role: p.role as Actor["role"], headOf: heads.map((h) => h.id) };
}

export const isAdmin = (a: Actor) => a.role === "admin";
export const mayEnter = (a: Actor) => isAdmin(a) || a.headOf.length > 0;
export const mayManageDepartment = (a: Actor, departmentId: string) => isAdmin(a) || a.headOf.includes(departmentId);

export async function mayManagePerson(db: Db, a: Actor, personId: string): Promise<boolean> {
  if (isAdmin(a)) return true;
  if (a.headOf.length === 0) return false;
  const rows = await db
    .select({ id: departmentMembers.personId })
    .from(departmentMembers)
    .innerJoin(departments, eq(departments.id, departmentMembers.departmentId))
    .where(and(eq(departmentMembers.personId, personId), inArray(departmentMembers.departmentId, a.headOf), eq(departments.tenantId, a.tenantId)));
  return rows.length > 0;
}

export async function mayEditPersona(db: Db, a: Actor, definitionId: string): Promise<boolean> {
  if (isAdmin(a)) return true;
  if (a.headOf.length === 0) return false;
  const rows = await db
    .select({ id: definitionDepartments.definitionId })
    .from(definitionDepartments)
    .where(and(eq(definitionDepartments.definitionId, definitionId), inArray(definitionDepartments.departmentId, a.headOf)));
  return rows.length > 0;
}

export async function mayUseDefinition(db: Db, tenantId: string, personId: string, definitionId: string): Promise<boolean> {
  const linked = await db.select({ id: definitionDepartments.departmentId }).from(definitionDepartments).where(eq(definitionDepartments.definitionId, definitionId));
  if (linked.length === 0) return true;
  const actor = await loadActor(db, tenantId, personId);
  if (!actor) return false;
  if (isAdmin(actor)) return true;
  const mine = await db
    .select({ id: departmentMembers.departmentId })
    .from(departmentMembers)
    .where(and(eq(departmentMembers.personId, personId), inArray(departmentMembers.departmentId, linked.map((l) => l.id))));
  return mine.length > 0;
}
