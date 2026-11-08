import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditEvents, botDefinitions, people } from "../db/schema.js";
import type { BalanceReader } from "../engine/balances.js";

/** The tenant-local day and hour, independent of the server's zone. */
export const localParts = (d: Date, timeZone: string) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
};

/** The last 24 hours, written for an admin who wants the shape of the day before opening the dashboard. */
export async function buildDailyReport(
  db: Db,
  tenantId: string,
  timezone: string,
  publicUrl: string,
  balance?: BalanceReader,
): Promise<{ subject: string; body: string }> {
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 60 * 60_000);
  const [rows, defs, ppl, wallet] = await Promise.all([
    db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantId), gte(auditEvents.startedAt, from)))
      .orderBy(desc(auditEvents.startedAt))
      .limit(5000),
    db.select({ id: botDefinitions.id, label: botDefinitions.label, displayName: botDefinitions.displayName }).from(botDefinitions).where(eq(botDefinitions.tenantId, tenantId)),
    db.select({ id: people.id, name: people.name }).from(people).where(eq(people.tenantId, tenantId)),
    balance ? balance().catch(() => undefined) : undefined,
  ]);
  const bot = new Map(defs.map((d) => [d.id, d.displayName ? `${d.displayName} · ${d.label}` : d.label]));
  const person = new Map(ppl.map((p) => [p.id, p.name]));
  const messages = rows.filter((r) => r.kind === "message");
  const tools = rows.filter((r) => r.kind === "tool");
  const failed = tools.filter((r) => r.status === "failed");
  const denied = tools.filter((r) => r.status === "denied");
  const pending = tools.filter((r) => r.status === "pending");
  const done = tools.filter((r) => r.status === "done");
  const spend = rows.reduce((sum, r) => sum + Number(r.costUsd ?? 0), 0);
  const served = new Set(messages.flatMap((r) => (r.personId ? [r.personId] : []))).size;
  const byBot = [...messages.reduce((m, r) => m.set(r.definitionId, (m.get(r.definitionId) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const byPerson = [...messages.reduce((m, r) => (r.personId ? m.set(r.personId, (m.get(r.personId) ?? 0) + 1) : m), new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const failures = [...failed.reduce((m, r) => m.set(r.summary, (m.get(r.summary) ?? 0) + 1), new Map<string, number>())].slice(0, 5);
  const date = new Intl.DateTimeFormat("en-AU", { timeZone: timezone, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(now);
  const lines = [
    `BE Teammate daily report — ${date}`,
    timezone,
    "",
    `Replies: ${messages.length}`,
    `Actions: ${tools.length} (${done.length} done, ${denied.length} declined, ${failed.length} failed, ${pending.length} waiting)`,
    `People served: ${served} of ${ppl.length}`,
    `Spend: $${spend.toFixed(2)}`,
    ...(wallet ? [`DeepSeek balance: ${wallet.currency === "USD" ? "$" : ""}${wallet.total.toFixed(2)}${wallet.available ? "" : ` (${wallet.error ?? "unavailable"})`}`] : []),
    "",
    "By bot:",
    ...(byBot.length ? byBot.map(([id, n]) => `- ${bot.get(id) ?? "unknown"}: ${n} ${n === 1 ? "reply" : "replies"}`) : ["- No replies."]),
    "",
    "Busiest people:",
    ...(byPerson.length ? byPerson.map(([id, n]) => `- ${person.get(id) ?? "someone"}: ${n}`) : ["- Nobody."]),
    "",
    "Failures:",
    ...(failures.length ? failures.map(([summary, n]) => `- ${summary}${n > 1 ? ` (${n})` : ""}`) : ["- None."]),
    "",
    `Dashboard: ${publicUrl.replace(/\/$/, "")}/admin`,
  ];
  return { subject: `Daily report — ${date}`, body: lines.join("\n") };
}
