import { and, count, eq, gte, inArray, max } from "drizzle-orm";
import express from "express";
import type { Router } from "express";
import { allowedDepartments, listDefinitions } from "../bots/definitions.js";
import { listActions } from "../audit/audit.js";
import type { Db } from "../db/client.js";
import { auditEvents, chatAssignments, departmentMembers, mailboxes, people, resourceSamples } from "../db/schema.js";
import type { BotDefinition } from "../db/schema.js";
import type { Actor } from "./access.js";
import { isAdmin } from "./access.js";
import { chip, html, layout, raw, scroll } from "./html.js";
import type { BalanceReader } from "../engine/balances.js";
import { chatNames } from "./chat-names.js";
import { inputWords, whenFor, whenIn } from "./words.js";
import type { SafeHtml } from "./html.js";
import { adminOf, wrap } from "./http.js";
import { getTenantSettings } from "../org/org.js";

/** Bots the actor may see: all for an admin, those linked to their departments for a head. */
export async function visibleBots(db: Db, actor: Actor): Promise<{ defs: BotDefinition[]; allowed: Map<string, string[]> }> {
  const defs: BotDefinition[] = [];
  const allowed = new Map<string, string[]>();
  for (const d of await listDefinitions(db, actor.tenantId)) {
    const a = await allowedDepartments(db, d.id);
    if (!isAdmin(actor) && (d.identity === "person" || !a.some((x) => actor.headOf.includes(x)))) continue;
    defs.push(d);
    allowed.set(d.id, a);
  }
  return { defs, allowed };
}

/** Name, role, email, model, last active. */
export async function botsTable(db: Db, tenantId: string, defs: BotDefinition[]): Promise<SafeHtml> {
  if (!defs.length) return html`<div class="be-empty">No bots yet.</div>`;
  const when = await whenFor(db, tenantId);
  const stamp = (d: Date | null | undefined) => when(d) || "never";
  const ids = defs.map((d) => d.id);
  const [boxes, last] = await Promise.all([
    db.select({ id: mailboxes.definitionId, address: mailboxes.address }).from(mailboxes).where(and(eq(mailboxes.tenantId, tenantId), inArray(mailboxes.definitionId, ids))),
    db.select({ id: auditEvents.definitionId, at: max(auditEvents.startedAt) }).from(auditEvents).where(and(eq(auditEvents.tenantId, tenantId), inArray(auditEvents.definitionId, ids))).groupBy(auditEvents.definitionId),
  ]);
  const [{ on }] = await db.select({ on: count() }).from(people).where(and(eq(people.tenantId, tenantId), eq(people.personalBot, true)));
  const address = new Map(boxes.map((b) => [b.id, b.address]));
  const active = new Map(last.map((l) => [l.id, l.at]));
  return scroll(html`<table class="be-table"><thead><tr><th>Name</th><th>Role</th><th>Email</th><th>Model</th><th>Last active</th></tr></thead><tbody>${defs.map(
    (d) => html`<tr><td class="nm"><a href="/admin/bots/${d.id}">${d.displayName ?? d.name}</a></td><td>${d.label}${d.identity === "person" ? ` · ${on} on` : ""}</td><td>${address.get(d.id) ?? ""}</td><td>${d.model}</td><td>${stamp(active.get(d.id))}</td></tr>`,
  )}</tbody></table>`);
}

/** Midnight (start of the local day, or of the local month) in the time zone, as an instant. */
export function localStart(now: Date, timeZone: string, unit: "day" | "month"): Date {
  const wall = (d: Date) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(d).map((x) => [x.type, Number(x.value)]));
    return { y: p.year, m: p.month, d: p.day, offset: Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(d.getTime() / 1000) * 1000 };
  };
  const w = wall(now);
  const local = Date.UTC(w.y, w.m - 1, unit === "month" ? 1 : w.d);
  // two passes so a daylight-saving change between now and midnight is followed
  const first = local - wall(new Date(local)).offset;
  return new Date(local - wall(new Date(first)).offset);
}

const PERIODS = ["today", "7d", "30d"] as const;
type Period = (typeof PERIODS)[number];
const PERIOD_WORDS: Record<Period, string> = { today: "today", "7d": "7 days", "30d": "30 days" };

const median = (xs: number[]) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export function overviewRoutes(db: Db, balance?: BalanceReader): Router {
  const router = express.Router();
  router.get(
    ["/", "/overview"],
    wrap(async (_req, res) => {
      const { actor, csrf } = adminOf(res);
      const { defs } = await visibleBots(db, actor);
      const definitionIds = defs.map((d) => d.id);
      // A head sees only their people's rows for their departments' bots, as on Activity.
      const personIds = isAdmin(actor)
        ? undefined
        : [...new Set((await db.select({ id: departmentMembers.personId }).from(departmentMembers).where(inArray(departmentMembers.departmentId, actor.headOf.length ? actor.headOf : [""]))).map((r) => r.id))];
      const scope = { tenantId: actor.tenantId, personIds, definitionIds };
      const empty = !!personIds && !personIds.length || !definitionIds.length;
      const now = new Date();
      const { timezone } = await getTenantSettings(db, actor.tenantId);
      const period = (PERIODS as readonly string[]).includes(String(_req.query.period)) ? (String(_req.query.period) as Period) : "7d";
      const days = period === "today" ? 1 : period === "7d" ? 7 : 30;
      const day = localStart(now, timezone, "day");
      const month = localStart(now, timezone, "month");
      const from = new Date(day.getTime() - (days - 1) * 86_400_000);
      const before = new Date(from.getTime() - days * 86_400_000); // the period before, for the comparison lines
      // shortcut: the rows are summed in memory; use SQL sums when volumes grow.
      const [pending, allRows, chatRows, people_, chatName] = empty
        ? [[], [], [], [], new Map<string, string>()]
        : await Promise.all([
            listActions(db, { ...scope, status: "pending", limit: 50 }),
            listActions(db, { ...scope, limit: 10_000 }).then((rows) => rows.filter((r) => r.startedAt >= (before < month ? before : month))),
            db.select({ id: chatAssignments.chatId }).from(chatAssignments).where(inArray(chatAssignments.definitionId, definitionIds)),
            db.select({ id: people.id, name: people.name }).from(people).where(eq(people.tenantId, actor.tenantId)),
            chatNames(db, actor.tenantId),
          ]);
      const personName = new Map(people_.map((p) => [p.id, p.name]));
      // the confirmation window is 10 minutes: an older pending row can no longer be approved
      const waiting = pending.filter((r) => r.kind === "tool" && r.startedAt.getTime() > now.getTime() - 10 * 60_000);
      const rows = allRows.filter((r) => r.startedAt >= from);
      const prev = allRows.filter((r) => r.startedAt >= before && r.startedAt < from);
      const monthRows = allRows.filter((r) => r.startedAt >= month);
      const messages = rows.filter((r) => r.kind === "message");
      const tools = rows.filter((r) => r.kind === "tool");
      const secs = (r: (typeof rows)[number]) => (r.timings?.sentAt ? [(Date.parse(r.timings.sentAt) - Date.parse(r.timings.receivedAt)) / 1000] : []);
      const replyTimes = messages.flatMap(secs);
      const typical = median(replyTimes);
      const slowest = replyTimes.length ? Math.max(...replyTimes) : undefined;
      const spend = (xs: typeof rows) => xs.reduce((sum, r) => sum + Number(r.costUsd ?? 0), 0);
      const failed = tools.filter((r) => r.status === "failed");
      const served = new Set(messages.flatMap((r) => (r.personId ? [r.personId] : [])));
      const prevMessages = prev.filter((r) => r.kind === "message").length;
      const change = prevMessages ? `${messages.length >= prevMessages ? "+" : ""}${Math.round(((messages.length - prevMessages) / prevMessages) * 100)}% on the ${PERIOD_WORDS[period]} before` : "no earlier period to compare";
      const name = new Map(defs.map((d) => [d.id, d.displayName ?? d.name]));
      const bot = new Map(defs.map((d) => [d.id, d]));
      const stamp = whenIn(timezone, now);
      const wallet = balance ? await balance().catch(() => undefined) : undefined;
      // host load: a sample a minute for a day, so a growing fleet shows as a trend rather than a number
      const samples = await db
        .select({ cpu: resourceSamples.cpuPct, used: resourceSamples.memUsed, total: resourceSamples.memTotal })
        .from(resourceSamples)
        .where(gte(resourceSamples.at, new Date(now.getTime() - 24 * 3600_000)))
        .orderBy(resourceSamples.at);
      const hostNow = samples[samples.length - 1];
      const pct = (v: number) => Math.max(0, Math.min(100, v));
      const spark = (values: number[]) => {
        if (values.length < 2) return "";
        const w = 100, h = 26;
        const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - (pct(v) / 100) * h).toFixed(1)}`);
        return `<svg class="be-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="trend"><polygon class="fill" points="0,${h} ${pts.join(" ")} ${w},${h}"/><polyline points="${pts.join(" ")}"/></svg>`;
      };
      const gb = (kb: number) => (kb / 1048576).toFixed(1);
      const loadPanel = samples.length
        ? html`<div class="be-spark-row">
<div class="be-spark-box"><div class="be-eyebrow">CPU · host</div><div class="v">${pct(hostNow!.cpu).toFixed(0)}<span class="u">%</span></div><div class="s">peak ${Math.max(...samples.map((x) => x.cpu)).toFixed(0)}% · ${samples.length} samples</div>${raw(spark(samples.map((x) => x.cpu)))}</div>
<div class="be-spark-box"><div class="be-eyebrow">Memory · host</div><div class="v">${gb(hostNow!.used)}<span class="u">GB</span></div><div class="s">of ${gb(hostNow!.total)} GB · ${pct((hostNow!.used / Math.max(1, hostNow!.total)) * 100).toFixed(0)}% used</div>${raw(spark(samples.map((x) => (x.used / Math.max(1, x.total)) * 100)))}</div>
</div>`
        : html`<div class="be-empty">Collecting host load — a sample lands every minute, the trend after a few.</div>`;
      const tile = (label: string, value: string, sub: string, cls = "") => html`<div class="be-tile ${cls}"><div class="be-eyebrow">${label}</div><div class="v">${value}</div><div class="s">${sub}</div></div>`;
      // replies per local day for the last seven days, oldest first
      const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
      const weekday = new Intl.DateTimeFormat("en-AU", { timeZone: timezone, weekday: "short" });
      const week = Array.from({ length: 7 }, (_, i) => new Date(day.getTime() - (6 - i) * 86_400_000));
      const perDay = week.map((d) => ({ label: d.getTime() === day.getTime() ? "today" : weekday.format(d), n: allRows.filter((r) => r.kind === "message" && dayKey.format(r.startedAt) === dayKey.format(d)).length }));
      const peak = Math.max(1, ...perDay.map((p) => p.n));
      // by bot: personal assistants are one line with counts only
      const byBot = new Map<string, { label: string; replies: number; cost: number }>();
      for (const r of rows) {
        const d = bot.get(r.definitionId);
        const key = d?.identity === "person" ? "personal" : r.definitionId;
        const label = d?.identity === "person" ? "Personal assistants" : d ? (d.displayName ? `${d.displayName} · ${d.label}` : d.label) : "";
        const e = byBot.get(key) ?? { label, replies: 0, cost: 0 };
        if (r.kind === "message") e.replies++;
        e.cost += Number(r.costUsd ?? 0);
        byBot.set(key, e);
      }
      const bots = [...byBot.values()].sort((a, b) => b.replies - a.replies);
      const mostReplies = Math.max(1, ...bots.map((b) => b.replies));
      const busiest = [...messages.reduce((m, r) => (r.personId ? m.set(r.personId, (m.get(r.personId) ?? 0) + 1) : m), new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, 5);
      const last = allRows.filter((r) => r.kind === "message").slice(0, 8);
      const failedBy = [...failed.reduce((m, r) => { const s = (r.toolName ?? "").replace(/^mcp__(.+?)__.*/, "$1").replace(/^conn-/, ""); return m.set(s, (m.get(s) ?? 0) + 1); }, new Map<string, number>())].map(([s, n]) => `${n} ${s}`).join(" · ");
      const switcher = html`<div class="be-seg" role="radiogroup" aria-label="period">${PERIODS.map((p) => html`<a href="/admin?period=${p}" class="${p === period ? "on" : ""}" ${p === period ? raw('aria-current="true"') : ""}>${PERIOD_WORDS[p]}</a>`)}</div>`;
      const body = html`<header class="be-pagehead"><div class="pt"><h1>Dashboard</h1><p class="meta">${stamp(now)} · ${timezone.split("/").pop()!.replace(/_/g, " ")} · ${defs.length} bots · ${new Set(chatRows.map((c) => c.id)).size} chats</p></div><div class="act">${switcher}</div></header>
${waiting.map((r) => html`<div class="be-notice warn"><span><b>${name.get(r.definitionId) ?? ""}</b> is waiting for approval: ${inputWords(r.summary)}</span><span class="n">${r.personId ? `asked by ${personName.get(r.personId) ?? ""} · ` : ""}${stamp(r.startedAt)}</span></div>`)}
<div class="be-tiles" style="margin-top:var(--space-12)">${tile("replies", String(messages.length), change)}${tile("actions", String(tools.length), `${tools.filter((r) => r.authority?.type === "confirmation").length} confirmed · ${tools.filter((r) => r.status === "denied").length} declined`)}${tile("people served", String(served.size), `of ${people_.length}`)}${tile("median reply", typical === undefined ? "none" : `${typical.toFixed(1)} s`, slowest === undefined ? "" : `slowest ${slowest.toFixed(0)} s`)}${tile("spend", `$${spend(rows).toFixed(2)}`, `$${spend(monthRows).toFixed(2)} this month so far`)}${tile("failed", String(failed.length), failedBy || "none", failed.length ? "bad" : "")}${tile("waiting approvals", String(waiting.length), waiting.length ? "in the chats now" : "none", waiting.length ? "warn" : "")}${wallet ? tile("deepseek balance", `${wallet.currency === "USD" ? "$" : ""}${wallet.total.toFixed(2)}`, wallet.available ? `checked ${stamp(wallet.checkedAt)}` : (wallet.error ?? "unavailable"), !wallet.available || wallet.total < 5 ? "warn" : "") : ""}</div>
<section class="be-section"><h3>Host load <span class="be-mono muted">last 24 hours</span></h3>${loadPanel}</section>
<div class="dash-cols">
<section class="be-section"><h3>Replies per day</h3><div class="be-bars" role="img" aria-label="Replies per day: ${perDay.map((p) => `${p.label} ${p.n}`).join(", ")}">${perDay.map((p) => html`<div class="bar${p.label === "today" ? " today" : ""}" style="height:${Math.round((p.n / peak) * 100)}%" title="${p.label}: ${p.n}"></div>`)}</div><div class="be-bars-key">${perDay.map((p) => html`<span>${p.label}</span>`)}</div></section>
<section class="be-section"><h3>By bot, ${PERIOD_WORDS[period]}</h3>${bots.length ? html`<table class="be-table lean"><tbody>${bots.map((b) => html`<tr><td>${b.label}</td><td class="w"><div class="be-meter"><div style="width:${Math.round((b.replies / mostReplies) * 100)}%"></div></div></td><td class="n">${b.replies} ${b.replies === 1 ? "reply" : "replies"} · $${b.cost.toFixed(2)}</td></tr>`)}</tbody></table>` : html`<div class="be-empty">Nothing yet.</div>`}
<h3>Busiest people</h3><p class="be-mono muted">${busiest.length ? busiest.map(([p, n]) => `${personName.get(p) ?? "someone"} ${n}`).join(" · ") : "nobody yet"}</p></section>
</div>
<section class="be-section"><h3>Last messages <a href="/admin/activity">all activity</a></h3>${
        last.length
          ? scroll(html`<table class="be-table"><thead><tr><th>Time</th><th>Who</th><th>What</th><th>Status</th></tr></thead><tbody>${last.map((r) => {
              const d = bot.get(r.definitionId);
              const who = html`${r.personId ? (personName.get(r.personId) ?? "") : "routine"} → <b>${name.get(r.definitionId) ?? ""}</b><div class="be-mono muted">${d?.identity === "person" ? "own chat · private" : (r.chatId && chatName.get(r.chatId)) || ""}</div>`;
              return html`<tr><td class="be-mono muted">${stamp(r.startedAt)}</td><td>${who}</td><td>${d?.identity === "person" ? html`<span class="muted">1 reply</span>` : r.summary}</td><td>${r.status === "done" ? "" : chip(r.status)}</td></tr>`;
            })}</tbody></table>`)
          : html`<div class="be-empty">Nothing yet.</div>`
      }</section>`;
      res.type("html").send(layout({ title: "Dashboard", body, actor, csrf }));
    }),
  );
  return router;
}
