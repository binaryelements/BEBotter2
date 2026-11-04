import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { chatAssignments, chats as chatsT, people, routines, tenants } from "../db/schema.js";
import type { Routine } from "../db/schema.js";
import { DirectoryError } from "../org/directory.js";
import { cronMatches, parseCron } from "./cron.js";

export type RoutineInput = {
  definitionId: string;
  chatId: string;
  prompt: string;
  schedule?: string;
  runAt?: Date;
  quiet?: boolean;
  background?: boolean;
  grantPersonId?: string | null;
  createdByPersonId: string;
};

function checkPrompt(prompt: string) {
  if (prompt.length < 1 || prompt.length > 4000) throw new DirectoryError("The prompt must be 1 to 4000 characters");
}
function checkSchedule(schedule: string) {
  try {
    parseCron(schedule);
  } catch (e) {
    throw new DirectoryError(e instanceof Error ? e.message : "Invalid schedule");
  }
}
async function checkGrant(db: Db, tenantId: string, personId: string) {
  const [p] = await db.select({ role: people.role }).from(people).where(and(eq(people.id, personId), eq(people.tenantId, tenantId)));
  if (p?.role !== "admin") throw new DirectoryError("Only an admin can grant a routine their access");
}

export async function createRoutine(db: Db, tenantId: string, input: RoutineInput): Promise<Routine> {
  if ((input.schedule === undefined) === (input.runAt === undefined)) throw new DirectoryError("Give exactly one of a schedule or a run time");
  checkPrompt(input.prompt);
  if (input.schedule !== undefined) checkSchedule(input.schedule);
  if (input.runAt && !(input.runAt.getTime() > Date.now())) throw new DirectoryError("The run time must be in the future");
  const [assigned] = await db
    .select({ chatId: chatAssignments.chatId })
    .from(chatAssignments)
    .innerJoin(chatsT, eq(chatsT.id, chatAssignments.chatId))
    .where(and(eq(chatAssignments.chatId, input.chatId), eq(chatAssignments.definitionId, input.definitionId), eq(chatsT.tenantId, tenantId)));
  if (!assigned) throw new DirectoryError("That bot is not assigned to this chat");
  if (input.grantPersonId) await checkGrant(db, tenantId, input.grantPersonId);
  const [row] = await db
    .insert(routines)
    .values({
      id: crypto.randomUUID(), tenantId, definitionId: input.definitionId, chatId: input.chatId, prompt: input.prompt,
      schedule: input.schedule ?? null, runAt: input.runAt ?? null, quiet: input.quiet ?? false, background: input.background ?? false,
      grantPersonId: input.grantPersonId ?? null, createdByPersonId: input.createdByPersonId,
    })
    .returning();
  return row;
}

export async function listRoutines(db: Db, tenantId: string, definitionId?: string): Promise<Routine[]> {
  return db
    .select()
    .from(routines)
    .where(and(eq(routines.tenantId, tenantId), definitionId ? eq(routines.definitionId, definitionId) : undefined))
    .orderBy(asc(routines.createdAt));
}

export async function updateRoutine(
  db: Db,
  tenantId: string,
  id: string,
  patch: Partial<Pick<Routine, "prompt" | "schedule" | "quiet" | "enabled" | "grantPersonId">>,
): Promise<Routine> {
  if (patch.prompt !== undefined) checkPrompt(patch.prompt);
  if (patch.schedule !== undefined) checkSchedule(patch.schedule ?? "");
  if (patch.grantPersonId) await checkGrant(db, tenantId, patch.grantPersonId);
  const [row] = await db.update(routines).set(patch).where(and(eq(routines.id, id), eq(routines.tenantId, tenantId))).returning();
  if (!row) throw new DirectoryError("No such routine");
  return row;
}

export async function deleteRoutine(db: Db, tenantId: string, id: string): Promise<void> {
  const gone = await db.delete(routines).where(and(eq(routines.id, id), eq(routines.tenantId, tenantId))).returning({ id: routines.id });
  if (!gone.length) throw new DirectoryError("No such routine");
}

// Local date and hh:mm in the tenant zone: a repeated wall-clock time after a fall-back runs once.
const localMinute = (d: Date, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", dateStyle: "short", timeStyle: "short" }).format(d);
const sameLocalMinute = (a: Date, b: Date, timeZone: string) => localMinute(a, timeZone) === localMinute(b, timeZone);

/** Routines due at `now`, each claimed by one conditional UPDATE so concurrent ticks or instances run it once. */
export async function claimDue(db: Db, now: Date): Promise<Routine[]> {
  const minuteStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const candidates = await db
    .select({ r: routines, timezone: tenants.timezone })
    .from(routines)
    .innerJoin(tenants, eq(tenants.id, routines.tenantId))
    .where(
      and(
        eq(routines.enabled, true),
        or(
          and(sql`${routines.schedule} is not null`, or(isNull(routines.lastRunAt), sql`${routines.lastRunAt} < ${minuteStart}`)),
          and(lte(routines.runAt, now), isNull(routines.lastRunAt)),
        ),
      ),
    );
  const claimed: Routine[] = [];
  for (const { r, timezone } of candidates) {
    let due = false;
    if (r.schedule !== null) {
      try {
        due = cronMatches(parseCron(r.schedule), now, timezone) && !(r.lastRunAt && sameLocalMinute(r.lastRunAt, now, timezone));
      } catch {
        due = false; // a stored schedule that no longer parses never runs
      }
    } else due = true;
    if (!due) continue;
    const [row] = await db
      .update(routines)
      .set({ lastRunAt: minuteStart, ...(r.schedule !== null ? {} : { enabled: false }) })
      .where(and(eq(routines.id, r.id), eq(routines.enabled, true), or(isNull(routines.lastRunAt), sql`${routines.lastRunAt} < ${minuteStart}`)))
      .returning();
    if (row) claimed.push(row);
  }
  return claimed;
}
