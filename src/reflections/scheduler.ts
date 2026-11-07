import { and, eq, gte, isNotNull } from "drizzle-orm";
import { listDefinitions } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { auditEvents, tenants } from "../db/schema.js";
import { getTenantSettings } from "../org/org.js";
import { runReflection } from "./run.js";
import type { ReflectionDeps } from "./run.js";
import { dayInZone, getReflection, hourInZone, reflectionKey } from "./store.js";

export type ReflectionSchedulerDeps = ReflectionDeps & { now?: () => Date };

const LOOKBACK_MS = 3 * 86_400_000;

/** The people with activity for a personal bot on `day`; a service bot is one reflection. */
async function ownersWithActivity(db: Db, tenantId: string, definitionId: string, day: string, timeZone: string, at: Date): Promise<string[]> {
  const rows = await db
    .select({ personId: auditEvents.personId, at: auditEvents.startedAt })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, tenantId),
        eq(auditEvents.definitionId, definitionId),
        gte(auditEvents.startedAt, new Date(at.getTime() - LOOKBACK_MS)),
        isNotNull(auditEvents.personId),
      ),
    );
  return [...new Set(rows.filter((r) => dayInZone(r.at, timeZone) === day).map((r) => r.personId!).filter(Boolean))];
}

async function hasActivity(db: Db, tenantId: string, definitionId: string, day: string, timeZone: string, at: Date): Promise<boolean> {
  const rows = await db
    .select({ at: auditEvents.startedAt })
    .from(auditEvents)
    .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.definitionId, definitionId), gte(auditEvents.startedAt, new Date(at.getTime() - LOOKBACK_MS))))
    .limit(500);
  return rows.some((r) => dayInZone(r.at, timeZone) === day);
}

/**
 * One pass: every tenant whose chosen hour it is, every bot with activity that day. Exported so a test
 * can run it once without waiting for the timer.
 */
export async function runReflectionTick(deps: ReflectionSchedulerDeps, at = (deps.now ?? (() => new Date()))()): Promise<void> {
  for (const t of await deps.db.select({ id: tenants.id }).from(tenants)) {
    const settings = await getTenantSettings(deps.db, t.id);
    if (settings.reflectionMode !== "propose" && settings.reflectionMode !== "auto") continue;
    if (hourInZone(at, settings.timezone) !== settings.reflectionHour) continue;
    const mode = settings.reflectionMode === "auto" ? "auto" : "propose";
    const day = dayInZone(at, settings.timezone);
    for (const definition of await listDefinitions(deps.db, t.id)) {
      if (definition.identity === "person") {
        for (const owner of await ownersWithActivity(deps.db, t.id, definition.id, day, settings.timezone, at)) {
          if (await getReflection(deps.db, reflectionKey(t.id, definition.id, owner, day))) continue;
          await runReflection(deps, {
            tenantId: t.id,
            definition,
            ownerPersonId: owner,
            day,
            timeZone: settings.timezone,
            mode,
            defaultChatId: settings.reflectionChatId,
            now: at,
          }).catch((err) => console.error(`reflection ${definition.id}/${owner} failed`, err));
        }
        continue;
      }
      if (!(await hasActivity(deps.db, t.id, definition.id, day, settings.timezone, at))) continue;
      if (await getReflection(deps.db, reflectionKey(t.id, definition.id, null, day))) continue;
      await runReflection(deps, {
        tenantId: t.id,
        definition,
        ownerPersonId: null,
        day,
        timeZone: settings.timezone,
        mode,
        defaultChatId: settings.reflectionChatId,
        now: at,
      }).catch((err) => console.error(`reflection ${definition.id} failed`, err));
    }
  }
}

/**
 * Once a day, at the tenant's chosen hour, each bot with activity reviews its day. Mode `propose` leaves
 * learnings for an admin; mode `auto` applies them and posts to the default group. A day is reflected on
 * once per bot (and per owner on Personal), so a restart or a second instance does not duplicate it.
 */
export function startReflectionScheduler(deps: ReflectionSchedulerDeps, intervalMs = 5 * 60_000, now = () => new Date()): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runReflectionTick({ ...deps, now }, now());
    } catch (err) {
      console.error("reflection tick failed", err);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  console.log("reflection scheduler started");
  return () => clearInterval(timer);
}
