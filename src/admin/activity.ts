import { eq, inArray } from "drizzle-orm";
import express from "express";
import type { Request, Router } from "express";
import { listActions } from "../audit/audit.js";
import type { Db } from "../db/client.js";
import { botDefinitions, definitionDepartments, departmentMembers, people } from "../db/schema.js";
import type { AuditEvent } from "../db/schema.js";
import { isAdmin } from "./access.js";
import { html, layout } from "./html.js";
import { adminOf, wrap } from "./http.js";
import { page } from "./oidc.js";

const PAGE = 100;
const CSV_MAX = 10_000;
const FILTERS = ["bot", "person", "chat", "status"] as const;

const q = (req: Request, name: string) => {
  const v = req.query[name];
  return typeof v === "string" && v ? v : undefined;
};

async function names(db: Db, tenantId: string) {
  const [ppl, defs] = await Promise.all([
    db.select({ id: people.id, name: people.name }).from(people).where(eq(people.tenantId, tenantId)),
    db.select({ id: botDefinitions.id, label: botDefinitions.label }).from(botDefinitions).where(eq(botDefinitions.tenantId, tenantId)),
  ]);
  return { person: new Map(ppl.map((p) => [p.id, p.name])), bot: new Map(defs.map((d) => [d.id, d.label])) };
}

const cells = (e: AuditEvent, n: Awaited<ReturnType<typeof names>>) => [
  e.startedAt.toISOString().slice(0, 16),
  (e.personId && n.person.get(e.personId)) || "",
  n.bot.get(e.definitionId) ?? "",
  e.toolName ?? "message",
  e.status,
  e.summary,
  e.authority ? (n.person.get(e.authority.personId) ?? "") : "",
];

const secs = (from: string, to?: string) => (to ? `${((Date.parse(to) - Date.parse(from)) / 1000).toFixed(1)}s` : "-");
/** Message rows with timings: total received to sent, then ready / first output / tools / reply. */
function timingText(e: AuditEvent): string {
  const t = e.timings;
  if (!t) return "";
  const total = t.sentAt ? `${secs(t.receivedAt, t.sentAt)} total: ` : "";
  return `${total}ready ${secs(t.receivedAt, t.engineReadyAt)} / first ${secs(t.receivedAt, t.firstOutputAt)} / tools ${t.firstToolAt ? secs(t.receivedAt, t.firstToolAt) : "-"} (${t.tools}) / reply ${secs(t.receivedAt, t.resultAt)}`;
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
      personId,
      personIds,
      definitionIds,
      before: q(req, "before"),
      limit,
    });
    return rows;
  }

  router.get(
    "/activity",
    wrap(async (req, res) => {
      const { actor, csrf } = adminOf(res);
      const rows = await fetchRows(req, res, PAGE);
      if (!rows) return;
      const n = await names(db, actor.tenantId);
      const keep = new URLSearchParams(FILTERS.flatMap((f) => (q(req, f) ? [[f, q(req, f)!]] : [])));
      const older = rows.length === PAGE ? new URLSearchParams([...keep, ["before", rows[rows.length - 1].id]]).toString() : "";
      const csv = keep.toString();
      const tr = rows.map((e) => {
        const c = cells(e, n);
        return html`<tr>${c.slice(0, 6).map((v) => html`<td>${v}</td>`)}<td>${timingText(e)}</td><td>${c[6] ? `confirmed by ${c[6]}` : ""}</td></tr>`;
      });
      res.type("html").send(
        layout({
          title: "Activity",
          body: html`<h1>Activity</h1>
<form method="get" action="/admin/activity"><input name="bot" value="${q(req, "bot") ?? ""}" placeholder="Bot id" aria-label="Bot"> <input name="person" value="${q(req, "person") ?? ""}" placeholder="Person id" aria-label="Person"> <input name="chat" value="${q(req, "chat") ?? ""}" placeholder="Chat id" aria-label="Chat"> <select name="status" aria-label="Status"><option value="">Any</option>${["pending", "done", "denied", "expired", "failed"].map((s) => html`<option ${s === q(req, "status") ? "selected" : ""}>${s}</option>`)}</select> <button>Filter</button> <a href="/admin/activity.csv${csv ? `?${csv}` : ""}">Export CSV</a></form>
<table><thead><tr><th>Time</th><th>Person</th><th>Bot</th><th>Tool</th><th>Status</th><th>Summary</th><th>Timing</th><th>Confirmed</th></tr></thead><tbody>${tr}</tbody></table>
${older ? html`<p><a href="/admin/activity?${older}">Older</a></p>` : ""}`,
          actor,
          csrf,
        }),
      );
    }),
  );

  router.get(
    "/activity.csv",
    wrap(async (req, res) => {
      const rows = await fetchRows(req, res, CSV_MAX);
      if (!rows) return;
      const n = await names(db, adminOf(res).actor.tenantId);
      const lines = ["time,person,bot,tool,status,summary,confirmed_by", ...rows.map((e) => cells(e, n).map(csvCell).join(","))];
      res
        .set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="activity.csv"', "Cache-Control": "no-store" })
        .send(lines.join("\r\n") + "\r\n");
    }),
  );

  return router;
}
