import { and, count, eq, gte, inArray, max } from "drizzle-orm";
import express from "express";
import type { Router } from "express";
import { allowedDepartments, listDefinitions } from "../bots/definitions.js";
import { listActions } from "../audit/audit.js";
import type { Db } from "../db/client.js";
import { auditEvents, chatAssignments, departmentMembers, mailboxes, people } from "../db/schema.js";
import type { BotDefinition } from "../db/schema.js";
import type { Actor } from "./access.js";
import { isAdmin } from "./access.js";
import { chip, html, layout, scroll } from "./html.js";
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

const stamp = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : "never");

/** Name, role, email, model, last active. */
export async function botsTable(db: Db, tenantId: string, defs: BotDefinition[]): Promise<SafeHtml> {
  if (!defs.length) return html`<div class="be-empty">No bots yet.</div>`;
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

const median = (xs: number[]) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export function overviewRoutes(db: Db): Router {
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
      const day = localStart(now, timezone, "day");
      const month = localStart(now, timezone, "month");
      // shortcut: the month's rows are summed in memory; use SQL sums when volumes grow.
      const [pending, recent, monthRows, chatRows] = empty
        ? [[], [], [], []]
        : await Promise.all([
            listActions(db, { ...scope, status: "pending", limit: 50 }),
            listActions(db, { ...scope, limit: 10 }),
            listActions(db, { ...scope, limit: 10_000 }).then((rows) => rows.filter((r) => r.startedAt >= month)),
            db.select({ id: chatAssignments.chatId }).from(chatAssignments).where(inArray(chatAssignments.definitionId, definitionIds)),
          ]);
      // the confirmation window is 10 minutes: an older pending row can no longer be approved
      const waiting = pending.filter((r) => r.kind === "tool" && r.startedAt.getTime() > now.getTime() - 10 * 60_000);
      const today = monthRows.filter((r) => r.startedAt >= day);
      const replies = today.flatMap((r) => (r.kind === "message" && r.timings?.sentAt ? [(Date.parse(r.timings.sentAt) - Date.parse(r.timings.receivedAt)) / 1000] : []));
      const typical = median(replies);
      const spend = monthRows.reduce((sum, r) => sum + Number(r.costUsd ?? 0), 0);
      const name = new Map(defs.map((d) => [d.id, d.displayName ?? d.name]));
      const tile = (label: string, value: string, cls = "") => html`<div class="be-tile ${cls}"><div class="be-eyebrow">${label}</div><div class="v">${value}</div></div>`;
      const body = html`<header class="be-pagehead"><div class="pt"><h1>Overview</h1></div></header>
${waiting.map((r) => html`<div class="be-notice warn"><span><b>${name.get(r.definitionId) ?? ""}</b> is waiting for approval: ${r.summary}</span><span class="n">${stamp(r.startedAt)}</span></div>`)}
<div class="be-tiles" style="margin-top:var(--space-12)">${tile("bots", String(defs.length))}${tile("chats", String(new Set(chatRows.map((c) => c.id)).size))}${tile("waiting approvals", String(waiting.length), waiting.length ? "warn" : "")}${tile("actions today", String(today.filter((r) => r.kind === "tool").length))}${tile("median reply time", typical === undefined ? "none today" : `${typical.toFixed(1)} s`)}${tile("spend this month", `$${spend.toFixed(2)}`)}</div>
<section class="be-section"><h3>Bots</h3>${await botsTable(db, actor.tenantId, defs)}</section>
<section class="be-section"><h3>Recent activity <a href="/admin/activity">all activity</a></h3>${
        recent.length
          ? scroll(html`<table class="be-table"><thead><tr><th>Time</th><th>Bot</th><th>Summary</th><th>Status</th></tr></thead><tbody>${recent.map((r) => html`<tr><td>${stamp(r.startedAt)}</td><td>${name.get(r.definitionId) ?? ""}</td><td>${r.summary}</td><td>${chip(r.status)}</td></tr>`)}</tbody></table>`)
          : html`<div class="be-empty">Nothing yet.</div>`
      }</section>`;
      res.type("html").send(layout({ title: "Overview", body, actor, csrf }));
    }),
  );
  return router;
}
