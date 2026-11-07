import { eq, inArray } from "drizzle-orm";
import express from "express";
import type { Request, Router } from "express";
import { listActions } from "../audit/audit.js";
import type { Db } from "../db/client.js";
import { botDefinitions, definitionDepartments, departmentMembers, people } from "../db/schema.js";
import type { AuditEvent } from "../db/schema.js";
import { toolLabel } from "../teams/cards.js";
import { isAdmin } from "./access.js";
import { chatNames } from "./chat-names.js";
import { inputWords, whenFor } from "./words.js";
import type { When } from "./words.js";
import { chip, html, layout, pageHead, scroll } from "./html.js";
import type { SafeHtml } from "./html.js";
import { adminOf, wrap } from "./http.js";
import { page } from "./oidc.js";

const PAGE = 100;
const CSV_MAX = 10_000;
const FILTERS = ["bot", "person", "chat", "status", "q"] as const;

const q = (req: Request, name: string) => {
  const v = req.query[name];
  return typeof v === "string" && v ? v : undefined;
};

type Scope = { personIds?: string[]; definitionIds?: string[] };
/** Names for the rows and the filter dropdowns; a head's dropdowns name only their own people, bots and the chats in their rows. */
async function names(db: Db, tenantId: string, scope: Scope, rows: AuditEvent[]) {
  const [ppl, defs, chat] = await Promise.all([
    db.select({ id: people.id, name: people.name }).from(people).where(eq(people.tenantId, tenantId)).orderBy(people.name),
    db.select({ id: botDefinitions.id, label: botDefinitions.label, displayName: botDefinitions.displayName }).from(botDefinitions).where(eq(botDefinitions.tenantId, tenantId)).orderBy(botDefinitions.label),
    chatNames(db, tenantId),
  ]);
  const within = <T extends { id: string }>(list: T[], ids?: string[]) => (ids ? list.filter((x) => ids.includes(x.id)) : list);
  const limited = scope.personIds || scope.definitionIds;
  if (limited) for (const id of chat.keys()) if (!rows.some((e) => e.chatId === id)) chat.delete(id);
  return {
    person: new Map(within(ppl, scope.personIds).map((p) => [p.id, p.name])),
    bot: new Map(within(defs, scope.definitionIds).map((d) => [d.id, d.displayName ? `${d.displayName} · ${d.label}` : d.label])),
    chat,
  };
}

const cells = (e: AuditEvent, n: Awaited<ReturnType<typeof names>>, when?: When) => [
  when ? when(e.startedAt) : e.startedAt.toISOString().slice(0, 16),
  (e.personId && n.person.get(e.personId)) || "",
  n.bot.get(e.definitionId) ?? "",
  (e.chatId && n.chat.get(e.chatId)) || "",
  e.toolName ? toolLabel(e.toolName, e.toolInput) : "message",
  e.status,
  when ? inputWords(e.summary) : e.summary,
  e.authority ? (n.person.get(e.authority.personId) ?? "") : "",
];

/** A filter as a dropdown of names; the value stays the id, so links and the csv keep working. */
const pick = (name: string, label: string, options: Map<string, string>, chosen: string | undefined) =>
  html`<select class="be-select" name="${name}" aria-label="${label}"><option value="">any ${label}</option>${[...options].map(([id, text]) => html`<option value="${id}" ${id === chosen ? "selected" : ""}>${text}</option>`)}</select>`;

const seconds = (from: string, to: string) => Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000);
/**
 * Message rows: received to sent as one bar. Only what is recorded is measured: the engine getting ready, the model
 * and its tools together (tool time alone is not recorded per turn), and delivery. Without a sent time the bar ends at the reply.
 */
export function timingParts(e: AuditEvent): { total: number; parts: { name: string; secs: number }[] } | undefined {
  const t = e.timings;
  if (!t?.engineReadyAt || !t.resultAt) return undefined;
  const parts = [
    { name: "engine ready", secs: seconds(t.receivedAt, t.engineReadyAt) },
    { name: "model and tools", secs: seconds(t.engineReadyAt, t.resultAt) },
    ...(t.sentAt ? [{ name: "delivery", secs: seconds(t.resultAt, t.sentAt) }] : []),
  ];
  return { total: parts.reduce((n, p) => n + p.secs, 0), parts };
}
function timingBar(e: AuditEvent): SafeHtml {
  const m = timingParts(e);
  if (!m) return html``;
  const fmt = (n: number) => `${n.toFixed(1)} s`;
  const label = `total ${fmt(m.total)}: ${m.parts.map((p) => `${p.name} ${fmt(p.secs)}`).join(", ")}`;
  // the breakdown is on hover; the row shows the bar and the total
  return html`<div class="be-timing" role="img" aria-label="${label}" title="${label}">${m.parts.map((p, i) => html`<span class="t${i + 1}" style="width:${m.total ? ((p.secs / m.total) * 100).toFixed(1) : 0}%"></span>`)}</div><span class="be-muted" title="${label}">${fmt(m.total)}</span>`;
}

// A leading = + - @ tab or CR would run as a formula in a spreadsheet.
const csvCell = (v: string) => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;

export function activityRoutes(db: Db): Router {
  const router = express.Router();

  /** Rows the viewer may see under the query-string filters, or undefined when the filter is forbidden. */
  async function fetchRows(req: Request, res: express.Response, limit: number) {
    const { actor } = adminOf(res);
    let personIds: string[] | undefined;
    let definitionIds: string[] | undefined;
    let personId = q(req, "person");
    if (!isAdmin(actor)) {
      const headOf = actor.headOf.length ? actor.headOf : [""];
      const [members, defs] = await Promise.all([
        db.select({ id: departmentMembers.personId }).from(departmentMembers).where(inArray(departmentMembers.departmentId, headOf)),
        db.select({ id: definitionDepartments.definitionId }).from(definitionDepartments).where(inArray(definitionDepartments.departmentId, headOf)),
      ]);
      personIds = [...new Set(members.map((r) => r.id))];
      // A head sees only their people's rows for bots linked to their departments: adding someone does not reveal their other bots.
      definitionIds = [...new Set(defs.map((r) => r.id))];
      if (personId && !personIds.includes(personId)) return page(res, 403, "Not allowed.");
      // A permitted person filter narrows the head's scope, so the department list is no longer needed.
      if (personId) personIds = undefined;
    }
    const rows = await listActions(db, {
      tenantId: actor.tenantId,
      definitionId: q(req, "bot"),
      chatId: q(req, "chat"),
      status: q(req, "status"),
      q: q(req, "q"),
      personId,
      personIds,
      definitionIds,
      before: q(req, "before"),
      limit,
    });
    // a head's person filter narrowed the query, but the dropdowns still list only their people
    const scope: Scope = isAdmin(actor) ? {} : { personIds: personIds ?? [personId!], definitionIds };
    return { rows, n: await names(db, actor.tenantId, scope, rows) };
  }

  router.get(
    "/activity",
    wrap(async (req, res) => {
      const { actor, csrf } = adminOf(res);
      const got = await fetchRows(req, res, PAGE);
      if (!got) return;
      const { rows, n } = got;
      const when = await whenFor(db, actor.tenantId);
      const keep =new URLSearchParams(FILTERS.flatMap((f) => (q(req, f) ? [[f, q(req, f)!]] : [])));
      const older = rows.length === PAGE ? new URLSearchParams([...keep, ["before", rows[rows.length - 1].id]]).toString() : "";
      const csv = keep.toString();
      const tr = rows.map((e) => {
        const c = cells(e, n, when);
        const cls = ["be-mono be-nowrap", "", "", "be-nowrap", ""];
        return html`<tr>${c.slice(0, 5).map((v, i) => (cls[i] ? html`<td class="${cls[i]}">${v}</td>` : html`<td>${v}</td>`))}<td>${chip(e.status)}${e.kind === "admin" ? html` ${chip("changed")}` : ""}</td><td>${c[6]}</td><td>${timingBar(e)}</td><td>${c[7] ? `confirmed by ${c[7]}` : ""}</td></tr>`;
      });
      const sel = { bot: q(req, "bot"), person: q(req, "person"), chat: q(req, "chat") };
      res.type("html").send(
        layout({
          title: "Activity",
          body: html`${pageHead("Activity", html`<a class="be-btn" href="/admin/activity.csv${csv ? `?${csv}` : ""}">export csv</a>`)}
<form class="row" method="get" action="/admin/activity"><input class="be-input" type="search" name="q" value="${q(req, "q") ?? ""}" placeholder="search summaries…" aria-label="Search"> ${pick("bot", "bot", n.bot, sel.bot)} ${pick("person", "person", n.person, sel.person)} ${pick("chat", "chat", n.chat, sel.chat)} <select class="be-select" name="status" aria-label="Status"><option value="">any status</option>${["pending", "done", "denied", "expired", "failed"].map((s) => html`<option ${s === q(req, "status") ? "selected" : ""}>${s}</option>`)}</select> <button class="be-btn primary">filter</button></form>
${tr.length ? scroll(html`<table class="be-table"><thead><tr><th>Time</th><th>Person</th><th>Bot</th><th>Chat</th><th>Tool</th><th>Status</th><th>Summary</th><th>Timing</th><th>Confirmed</th></tr></thead><tbody>${tr}</tbody></table>`) : html`<div class="be-empty">Nothing here.</div>`}
${older ? html`<p><a href="/admin/activity?${older}">older</a></p>` : ""}`,
          actor,
          csrf,
        }),
      );
    }),
  );

  router.get(
    "/activity.csv",
    wrap(async (req, res) => {
      const got = await fetchRows(req, res, CSV_MAX);
      if (!got) return;
      const { rows, n } = got;
      const lines = ["time,person,bot,chat,tool,status,summary,confirmed_by", ...rows.map((e) => cells(e, n).map(csvCell).join(","))];
      res
        .set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="activity.csv"', "Cache-Control": "no-store" })
        .send(lines.join("\r\n") + "\r\n");
    }),
  );

  return router;
}
