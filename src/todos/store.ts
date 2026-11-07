import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { todos } from "../db/schema.js";
import type { Todo } from "../db/schema.js";
import { DirectoryError } from "../org/directory.js";

const TITLE_MAX = 200;
const DETAILS_MAX = 4000;

const cleanTitle = (title: string) => {
  const t = title.trim();
  if (!t) throw new DirectoryError("A to-do needs a title");
  if (t.length > TITLE_MAX) throw new DirectoryError(`A to-do title is at most ${TITLE_MAX} characters`);
  return t;
};
const cleanDetails = (details: string | undefined) => {
  const d = details?.trim();
  if (d && d.length > DETAILS_MAX) throw new DirectoryError(`To-do details are at most ${DETAILS_MAX} characters`);
  return d || null;
};
const cleanDue = (dueAt: string | Date | undefined) => {
  if (!dueAt) return null;
  const d = dueAt instanceof Date ? dueAt : new Date(dueAt);
  if (Number.isNaN(d.getTime())) throw new DirectoryError("Due date is not a date");
  return d;
};

export async function addTodo(
  db: Db,
  input: { tenantId: string; personId: string; definitionId?: string | null; requestId?: string | null; title: string; details?: string; dueAt?: string | Date },
): Promise<Todo> {
  const [row] = await db
    .insert(todos)
    .values({
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      personId: input.personId,
      definitionId: input.definitionId ?? null,
      requestId: input.requestId ?? null,
      title: cleanTitle(input.title),
      details: cleanDetails(input.details),
      dueAt: cleanDue(input.dueAt),
    })
    .returning();
  return row;
}

export async function listTodos(db: Db, tenantId: string, personId: string, opts: { status?: "open" | "done"; limit?: number } = {}): Promise<Todo[]> {
  const status = opts.status ? eq(todos.status, opts.status) : undefined;
  return db
    .select()
    .from(todos)
    .where(and(eq(todos.tenantId, tenantId), eq(todos.personId, personId), status))
    .orderBy(asc(sql`case when ${todos.status} = 'done' then 1 else 0 end`), asc(todos.dueAt), desc(todos.createdAt))
    .limit(opts.limit ?? 50);
}

export async function getTodo(db: Db, tenantId: string, personId: string, id: string): Promise<Todo | undefined> {
  const [row] = await db.select().from(todos).where(and(eq(todos.tenantId, tenantId), eq(todos.personId, personId), eq(todos.id, id)));
  return row;
}

export async function completeTodo(db: Db, tenantId: string, personId: string, id: string, done = true): Promise<Todo | undefined> {
  const [row] = await db
    .update(todos)
    .set({ status: done ? "done" : "open", completedAt: done ? new Date() : null, updatedAt: new Date() })
    .where(and(eq(todos.tenantId, tenantId), eq(todos.personId, personId), eq(todos.id, id)))
    .returning();
  return row;
}

export async function updateTodo(
  db: Db,
  tenantId: string,
  personId: string,
  id: string,
  f: { title?: string; details?: string; dueAt?: string | Date | null },
): Promise<Todo | undefined> {
  const set: Partial<typeof todos.$inferInsert> = { updatedAt: new Date() };
  if (f.title !== undefined) set.title = cleanTitle(f.title);
  if (f.details !== undefined) set.details = cleanDetails(f.details);
  if (f.dueAt !== undefined) set.dueAt = f.dueAt === null ? null : cleanDue(f.dueAt);
  const [row] = await db
    .update(todos)
    .set(set)
    .where(and(eq(todos.tenantId, tenantId), eq(todos.personId, personId), eq(todos.id, id)))
    .returning();
  return row;
}

export async function deleteTodo(db: Db, tenantId: string, personId: string, id: string): Promise<void> {
  await db.delete(todos).where(and(eq(todos.tenantId, tenantId), eq(todos.personId, personId), eq(todos.id, id)));
}

/** Open to-do counts for a set of people, for the assistant cards. */
export async function countOpenTodos(db: Db, tenantId: string, personIds: string[]): Promise<Map<string, number>> {
  if (!personIds.length) return new Map();
  const rows = await db
    .select({ personId: todos.personId, n: count() })
    .from(todos)
    .where(and(eq(todos.tenantId, tenantId), eq(todos.status, "open"), inArray(todos.personId, personIds)))
    .groupBy(todos.personId);
  return new Map(rows.map((r) => [r.personId, Number(r.n)]));
}
