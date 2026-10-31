import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { botDefinitions, definitionDepartments, departmentMembers, departments, people } from "../db/schema.js";

export type Actor = { personId: string; tenantId: string; name: string; role: "user" | "admin"; headOf: string[] };

export async function loadActor(db: Db, tenantId: string, personId: string): Promise<Actor | undefined> {
  const [p] = await db.select().from(people).where(and(eq(people.id, personId), eq(people.tenantId, tenantId)));
  if (!p) return undefined;
  const heads = await db
    .select({ id: departmentMembers.departmentId })
    .from(departmentMembers)
    .innerJoin(departments, eq(departments.id, departmentMembers.departmentId))
    .where(and(eq(departmentMembers.personId, personId), eq(departmentMembers.isHead, true), eq(departments.tenantId, tenantId)));
  return { personId, tenantId, name: p.name, role: p.role as Actor["role"], headOf: heads.map((h) => h.id) };
}

export const isAdmin = (a: Actor) => a.role === "admin";
export const mayEnter = (a: Actor) => isAdmin(a) || a.headOf.length > 0;
export const mayManageDepartment = (a: Actor, departmentId: string) => isAdmin(a) || a.headOf.includes(departmentId);

async function inTenant(db: Db, tenantId: string, table: typeof people | typeof botDefinitions, id: string): Promise<boolean> {
  const rows = await db.select({ id: table.id }).from(table).where(and(eq(table.id, id), eq(table.tenantId, tenantId)));
  return rows.length > 0;
}

export async function mayManagePerson(db: Db, a: Actor, personId: string): Promise<boolean> {
  if (!(await inTenant(db, a.tenantId, people, personId))) return false;
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
  if (!(await inTenant(db, a.tenantId, botDefinitions, definitionId))) return false;
  if (isAdmin(a)) return true;
  if (a.headOf.length === 0) return false;
  const rows = await db
    .select({ id: definitionDepartments.definitionId })
    .from(definitionDepartments)
    .where(and(eq(definitionDepartments.definitionId, definitionId), inArray(definitionDepartments.departmentId, a.headOf)));
  return rows.length > 0;
}

export async function mayUseDefinition(db: Db, tenantId: string, personId: string, definitionId: string): Promise<boolean> {
  // One row per linked department, or one row with a null department when there are none; no rows means not in this tenant.
  const links = await db
    .select({ id: definitionDepartments.departmentId })
    .from(botDefinitions)
    .leftJoin(definitionDepartments, eq(definitionDepartments.definitionId, botDefinitions.id))
    .where(and(eq(botDefinitions.id, definitionId), eq(botDefinitions.tenantId, tenantId)));
  if (links.length === 0) return false;
  const linked = links.flatMap((l) => (l.id ? [l.id] : []));
  if (linked.length === 0) return true;
  const [p] = await db.select({ role: people.role }).from(people).where(and(eq(people.id, personId), eq(people.tenantId, tenantId)));
  if (!p) return false;
  if (p.role === "admin") return true;
  const mine = await db
    .select({ id: departmentMembers.departmentId })
    .from(departmentMembers)
    .where(and(eq(departmentMembers.personId, personId), inArray(departmentMembers.departmentId, linked)));
  return mine.length > 0;
}

/** Who may click yes on a card: the asker (writes only), an admin, or a head of a department allowed to use the definition. */
export function confirmerPolicy(
  db: Db,
  tenantId: string,
  definitionId: string,
  askerPersonId: string | null,
  kind: "write" | "approve",
): (clickerPersonId: string) => Promise<boolean> {
  return async (clickerPersonId) => {
    const actor = await loadActor(db, tenantId, clickerPersonId);
    if (!actor) return false;
    if (kind === "write" && clickerPersonId === askerPersonId) return true;
    if (isAdmin(actor)) return true;
    if (actor.headOf.length === 0) return false;
    const links = await db
      .select({ id: definitionDepartments.departmentId })
      .from(botDefinitions)
      .leftJoin(definitionDepartments, eq(definitionDepartments.definitionId, botDefinitions.id))
      .where(and(eq(botDefinitions.id, definitionId), eq(botDefinitions.tenantId, tenantId)));
    const linked = links.flatMap((l) => (l.id ? [l.id] : []));
    return links.length > 0 && (linked.length === 0 || linked.some((d) => actor.headOf.includes(d)));
  };
}
