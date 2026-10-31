import { and, eq, gte, inArray, max } from "drizzle-orm";
import express from "express";
import type { Router } from "express";
import { allowedDepartments, listDefinitions } from "../bots/definitions.js";
import { listActions } from "../audit/audit.js";
import type { Db } from "../db/client.js";
import { auditEvents, chatAssignments, departmentMembers, mailboxes } from "../db/schema.js";
import type { BotDefinition } from "../db/schema.js";
import type { Actor } from "./access.js";
import { isAdmin } from "./access.js";
import { html, layout } from "./html.js";
import type { SafeHtml } from "./html.js";
import { adminOf, wrap } from "./http.js";

/** Bots the actor may see: all for an admin, those linked to their departments for a head. */
export async function visibleBots(db: Db, actor: Actor): Promise<{ defs: BotDefinition[]; allowed: Map<string, string[]> }> {
  const defs: BotDefinition[] = [];
  const allowed = new Map<string, string[]>();
  for (const d of await listDefinitions(db, actor.tenantId)) {
    const a = await allowedDepartments(db, d.id);
    if (!isAdmin(actor) && !a.some((x) => actor.headOf.includes(x))) continue;
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
  const address = new Map(boxes.map((b) => [b.id, b.address]));
  const active = new Map(last.map((l) => [l.id, l.at]));
  return html`<table class="be-table"><thead><tr><th>Name</th><th>Role</th><th>Email</th><th>Model</th><th>Last active</th></tr></thead><tbody>${defs.map(
    (d) => html`<tr><td class="nm"><a href="/admin/bots/${d.id}">${d.displayName ?? d.name}</a></td><td>${d.label}</td><td>${address.get(d.id) ?? ""}</td><td>${d.model}</td><td>${stamp(active.get(d.id))}</td></tr>`,
  )}</tbody></table>`;
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
      const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      // shortcut: days and months are UTC and the month's rows are summed in memory; use the tenant timezone and SQL sums when volumes grow.
      const [pending, recent, monthRows, chatRows] = empty
        ? [[], [], [], []]
        : await Promise.all([
            listActions(db, { ...scope, status: "pending", limit: 50 }),
            listActions(db, { ...scope, limit: 10 }),
            listActions(db, { ...scope, limit: 10_000 }).then((rows) => rows.filter((r) => r.startedAt >= month)),
            db.select({ id: chatAssignments.chatId }).from(chatAssignments).where(inArray(chatAssignments.definitionId, definitionIds)),
          ]);
      const waiting = pending.filter((r) => r.kind === "tool");
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
          ? html`<table class="be-table"><thead><tr><th>Time</th><th>Bot</th><th>Summary</th><th>Status</th></tr></thead><tbody>${recent.map((r) => html`<tr><td>${stamp(r.startedAt)}</td><td>${name.get(r.definitionId) ?? ""}</td><td>${r.summary}</td><td>${r.status}</td></tr>`)}</tbody></table>`
          : html`<div class="be-empty">Nothing yet.</div>`
      }</section>`;
      res.type("html").send(layout({ title: "Overview", body, actor, csrf }));
    }),
  );
  return router;
}
