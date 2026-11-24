import express from "express";
import type { Request, Response, Router } from "express";
import { and, asc, count, desc, eq, inArray, notInArray } from "drizzle-orm";
import { getDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import type { BotDefinition, Workflow } from "../db/schema.js";
import { botDefinitions, people, workflowRunEvents, workflowRuns, workflows } from "../db/schema.js";
import { DirectoryError } from "../org/directory.js";
import { endRun, moveRun, pauseRun } from "../workflows/runs.js";
import type { Notify } from "../workflows/runs.js";
import { inOrder, tracePath } from "../workflows/trace.js";
import { createWorkflow, discardDraft, draftHash, listVersions, publish, publishedGraph, restoreVersion, runsOnRemovedNodes, saveDraft, StaleDraft } from "../workflows/store.js";
import type { Actor } from "./access.js";
import { isAdmin, mayEditPersona } from "./access.js";
import { chip, href, html, layout, raw, scroll } from "./html.js";
import type { SafeHtml } from "./html.js";
import { adminOf, wrap } from "./http.js";
import { page } from "./oidc.js";
import { whenFor } from "./words.js";

/** The bot's Workflows tab: its workflows with their runs, and the form that starts a new one. */
export async function workflowsSection(db: Db, def: BotDefinition, chats: { id: string; label: string; lastSeenAt?: Date | null }[], csrf: SafeHtml): Promise<SafeHtml> {
  const rows = await db.select().from(workflows).where(and(eq(workflows.definitionId, def.id), eq(workflows.tenantId, def.tenantId))).orderBy(asc(workflows.createdAt));
  const counts = rows.length
    ? await db.select({ wid: workflowRuns.workflowId, status: workflowRuns.status, n: count() }).from(workflowRuns).where(inArray(workflowRuns.workflowId, rows.map((w) => w.id))).groupBy(workflowRuns.workflowId, workflowRuns.status)
    : [];
  const runs = (wid: string, keep: (status: string) => boolean) => counts.filter((c) => c.wid === wid && keep(c.status)).reduce((n, c) => n + c.n, 0);
  const base = `/admin/bots/${def.id}/workflows`;
  const row = (w: Workflow) => html`<tr><td><a href="${base}/${w.id}">${w.name}</a></td><td>${w.publishedVersion ? `live v${w.publishedVersion}` : "draft only"}</td><td><a href="${base}/${w.id}/runs">${runs(w.id, (s) => s !== "done" && s !== "failed")}</a></td><td>${runs(w.id, (s) => s === "needs_person")}</td></tr>`;
  return html`<h2>Workflows</h2>
${rows.length ? scroll(html`<table class="be-table"><thead><tr><th>Workflow</th><th>Version</th><th>Open runs</th><th>Needs a person</th></tr></thead><tbody>${rows.map(row)}</tbody></table>`) : html`<div class="be-empty">No workflows yet.</div>`}
<h3>New workflow</h3>
${chats.length
    ? html`<form class="be-form" method="post" action="${base}">${csrf}<div class="fields"><label>name<input name="name" required maxlength="120" pattern=".*\\S.*" autocomplete="off" title="Name the workflow"></label><label>chat<span class="hint">where it works and asks. A chat named after people? Name it on <a href="/admin/assignments">assignments</a>.</span><select class="be-select" name="chatId" required>${chats.map((c) => html`<option value="${c.id}">${c.label}${c.lastSeenAt ? ` · last active ${c.lastSeenAt.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}` : ""}</option>`)}</select></label></div><button class="be-btn primary">new workflow</button></form>`
    : html`<p class="muted">Add this bot to a chat first: a workflow works and asks in one. <a href="/admin/bots/${def.id}?tab=chats">chats</a></p>`}`;
}

const PAGE = 50;

export function workflowRoutes(db: Db, notify: Notify = async () => {}): Router {
  const router = express.Router();
  const notFound = (res: Response) => page(res, 404, "Not found.");
  // a workflow of the actor's tenant whose bot is not a person bot and that the actor may see (a head: only their departments' bots, as on the bot page);
  // anything else does not exist here
  const ownWorkflow = async (actor: Actor, wid: string) => {
    const [r] = await db.select({ w: workflows, identity: botDefinitions.identity }).from(workflows).innerJoin(botDefinitions, eq(botDefinitions.id, workflows.definitionId))
      .where(and(eq(workflows.id, wid), eq(workflows.tenantId, actor.tenantId)));
    return r && r.identity !== "person" && (await mayEditPersona(db, actor, r.w.definitionId)) ? r.w : undefined;
  };

  router.post(
    "/bots/:id/workflows",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      const def = await getDefinition(db, actor.tenantId, req.params.id);
      if (!def || def.identity === "person") return notFound(res);
      if (!isAdmin(actor)) return page(res, 403, "Not allowed.");
      const name = String(req.body.name ?? "").trim();
      if (!name) throw new DirectoryError("Name the workflow");
      const w = await createWorkflow(db, actor.tenantId, { definitionId: def.id, name, chatId: String(req.body.chatId ?? ""), runAsPersonId: actor.personId });
      res.redirect(303, `/admin/bots/${def.id}/workflows/${w.id}`);
    }),
  );

  router.get(
    "/bots/:id/workflows/:wid",
    wrap(async (req, res) => {
      const { actor, csrf } = adminOf(res);
      const w = await ownWorkflow(actor, req.params.wid);
      if (!w || w.definitionId !== req.params.id) return notFound(res);
      const def = (await getDefinition(db, actor.tenantId, w.definitionId))!;
      const ppl = await db.select({ id: people.id, name: people.name }).from(people).where(and(eq(people.tenantId, actor.tenantId), eq(people.licensed, true))).orderBy(asc(people.name));
      // a run of this workflow only; any other id shows no trace
      const [mine] = typeof req.query.trace === "string" ? await db.select({ id: workflowRuns.id }).from(workflowRuns).where(and(eq(workflowRuns.id, req.query.trace), eq(workflowRuns.workflowId, w.id))) : [];
      const trace = mine ? await tracePath(db, actor.tenantId, mine.id) : undefined;
      // a trace shows the graph the run executed, so it draws the published one (read-only), else the draft
      const shown = (trace && (await publishedGraph(db, w.id))) || w.draft;
      const init = { workflowId: w.id, name: w.name, elkSrc: href("workflows/elk.js"), draft: shown, base: draftHash(w.draft), published: w.publishedVersion !== null, people: ppl, csrf, readOnly: !isAdmin(actor) || !!trace, ...(trace ? { trace } : {}) };
      // inside a script element only "</script" can end it early, so every "<" is escaped
      const json = JSON.stringify(init).replace(/</g, "\\u003c");
      const body = html`<header class="be-pagehead"><div class="pt"><nav class="crumb" aria-label="breadcrumb"><a href="/admin/bots">bots</a> / <a href="/admin/bots/${def.id}?tab=workflows">${def.displayName ?? def.name}</a> / <span aria-current="page">${w.name}</span></nav><h1>${w.name}</h1></div></header>
<link rel="stylesheet" href="${href("workflows/canvas.css")}">
<div id="wf-canvas"></div>
<script type="application/json" id="wf-init">${raw(json)}</script>
<script src="${href("workflows/canvas.js")}"></script>
<script>WFCanvas.mount(document.getElementById("wf-canvas"), JSON.parse(document.getElementById("wf-init").textContent));</script>`;
      res.type("html").send(layout({ title: w.name, body, actor, csrf }));
    }),
  );

  // step labels from the live graph, else the draft
  const labelsOf = async (w: Workflow) => {
    const g = (await publishedGraph(db, w.id)) ?? w.draft;
    return { nodes: g.nodes, label: (id: string) => g.nodes.find((n) => n.id === id)?.label ?? id };
  };
  const crumb = (def: BotDefinition, w: Workflow, last: string) => html`<nav class="crumb" aria-label="breadcrumb"><a href="/admin/bots">bots</a> / <a href="/admin/bots/${def.id}?tab=workflows">${def.displayName ?? def.name}</a> / <a href="/admin/bots/${def.id}/workflows/${w.id}">${w.name}</a> / <span aria-current="page">${last}</span></nav>`;

  router.get(
    "/bots/:id/workflows/:wid/runs",
    wrap(async (req, res) => {
      const { actor, csrf } = adminOf(res);
      const w = await ownWorkflow(actor, req.params.wid);
      if (!w || w.definitionId !== req.params.id) return notFound(res);
      const def = (await getDefinition(db, actor.tenantId, w.definitionId))!;
      const show = ["needs_person", "all"].includes(String(req.query.show)) ? String(req.query.show) : "open";
      const pageNo = Math.max(1, Math.floor(Number(req.query.page)) || 1);
      const where = and(eq(workflowRuns.workflowId, w.id), show === "needs_person" ? eq(workflowRuns.status, "needs_person") : show === "open" ? notInArray(workflowRuns.status, ["done", "failed"]) : undefined);
      const rows = await db.select().from(workflowRuns).where(where).orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id)).limit(PAGE + 1).offset((pageNo - 1) * PAGE);
      const runs = rows.slice(0, PAGE);
      const reasons = new Map<string, string>();
      if (runs.length) {
        const evs = await db.select({ runId: workflowRunEvents.runId, reason: workflowRunEvents.reason, kind: workflowRunEvents.kind, at: workflowRunEvents.at }).from(workflowRunEvents).where(and(inArray(workflowRunEvents.runId, runs.map((r) => r.id)), eq(workflowRunEvents.kind, "result")));
        for (const e of inOrder(evs)) if (e.reason) reasons.set(e.runId, e.reason);
      }
      const { label } = await labelsOf(w);
      const when = await whenFor(db, actor.tenantId);
      const base = `/admin/bots/${def.id}/workflows/${w.id}/runs`;
      const tab = (key: string, text: string) => html`<a class="be-btn sm${show === key ? " on" : ""}" href="${base}?show=${key}">${text}</a>`;
      const row = (r: (typeof runs)[number]) => html`<tr><td><a href="/admin/workflow-runs/${r.id}">${r.title}</a></td><td>${label(r.nodeId)}</td><td>${chip(r.status)}</td><td>${when(r.dueAt)}</td><td>${reasons.get(r.id) ?? ""}</td></tr>`;
      const body = html`<header class="be-pagehead"><div class="pt">${crumb(def, w, "runs")}<h1>Runs</h1></div></header>
<p class="bot-chips">${tab("open", "open")}${tab("needs_person", "needs a person")}${tab("all", "all")}</p>
${runs.length ? scroll(html`<table class="be-table"><thead><tr><th>Run</th><th>Step</th><th>Status</th><th>Next due</th><th>Last result</th></tr></thead><tbody>${runs.map(row)}</tbody></table>`) : html`<div class="be-empty">No runs.</div>`}
<p>${pageNo > 1 ? html`<a href="${base}?show=${show}&page=${pageNo - 1}">newer</a> ` : ""}${rows.length > PAGE ? html`<a href="${base}?show=${show}&page=${pageNo + 1}">older</a>` : ""}</p>`;
      res.type("html").send(layout({ title: "Runs", body, actor, csrf }));
    }),
  );

  // a run of a workflow the actor may see; anything else does not exist here
  const ownRun = async (actor: Actor, runId: string) => {
    const [run] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.tenantId, actor.tenantId)));
    const w = run && (await ownWorkflow(actor, run.workflowId));
    return run && w ? { run, w } : undefined;
  };

  router.get(
    "/workflow-runs/:runId",
    wrap(async (req, res) => {
      const { actor, csrf } = adminOf(res);
      const found = await ownRun(actor, req.params.runId);
      if (!found) return notFound(res);
      const { run, w } = found;
      const def = (await getDefinition(db, actor.tenantId, w.definitionId))!;
      const { nodes, label } = await labelsOf(w);
      const when = await whenFor(db, actor.tenantId);
      const events = await db.select().from(workflowRunEvents).where(eq(workflowRunEvents.runId, run.id)).orderBy(asc(workflowRunEvents.at));
      const act = `/admin/workflow-runs/${run.id}`;
      const button = (verb: string) => html`<form method="post" action="${act}/${verb}" style="display:inline-flex;gap:6px">${csrf}<button class="be-btn sm">${verb}</button></form>`;
      const admin = isAdmin(actor);
      const buttons = html`${admin && (run.status === "ready" || run.status === "waiting") ? button("pause") : ""}${admin && !["running", "done", "failed"].includes(run.status) ? button("end") : ""}${admin && run.status === "needs_person" ? html`<form method="post" action="${act}/move" style="display:inline-flex;gap:6px">${csrf}<select class="be-select" name="nodeId" aria-label="step" required>${nodes.filter((n) => n.type !== "trigger").map((n) => html`<option value="${n.id}">${n.label}</option>`)}</select><button class="be-btn sm">move</button></form>` : ""}<a class="be-btn sm" href="/admin/bots/${def.id}/workflows/${w.id}?trace=${run.id}">trace</a>`;
      const row = (e: (typeof events)[number]) => html`<tr><td>${when(e.at)}</td><td>${label(e.nodeId)}</td><td>${e.kind}</td><td>${e.result ?? ""}</td><td>${e.reason ?? ""}</td></tr>`;
      const body = html`<header class="be-pagehead"><div class="pt">${crumb(def, w, run.title)}<h1>${run.title}</h1></div><div class="act">${buttons}</div></header>
<p>${chip(run.status)} ${label(run.nodeId)}${run.dueAt ? html` · due ${when(run.dueAt)}` : ""}${run.outcome ? html` · ${run.outcome}` : ""}</p>
${events.length ? scroll(html`<table class="be-table"><thead><tr><th>Time</th><th>Step</th><th>Kind</th><th>Result</th><th>Reason</th></tr></thead><tbody>${events.map(row)}</tbody></table>`) : html`<div class="be-empty">No history.</div>`}`;
      res.type("html").send(layout({ title: run.title, body, actor, csrf }));
    }),
  );

  // form posts: a refusal (DirectoryError) goes back to the run page as a notice
  const act = (fn: (runId: string, body: Record<string, unknown>, actor: Actor) => Promise<void>) =>
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!(await ownRun(actor, req.params.runId))) return notFound(res);
      if (!isAdmin(actor)) return page(res, 403, "Not allowed.");
      await fn(req.params.runId, req.body ?? {}, actor);
      res.redirect(303, `/admin/workflow-runs/${req.params.runId}`);
    });
  router.post("/workflow-runs/:runId/pause", act((id, _b, a) => pauseRun(db, a.tenantId, id, a.personId)));
  router.post("/workflow-runs/:runId/end", act((id, _b, a) => endRun(db, a.tenantId, id, a.personId)));
  router.post("/workflow-runs/:runId/move", act((id, b, a) => moveRun(db, a.tenantId, id, String(b.nodeId ?? ""), a.personId, notify)));

  // JSON routes for the canvas: 404 for someone else's workflow, 403 for a change by a non-admin, the store's refusals as 400
  const api = (mutates: boolean, fn: (w: Workflow, body: Record<string, unknown>, actor: Actor) => Promise<unknown>) =>
    wrap(async (req: Request, res: Response) => {
      const { actor } = adminOf(res);
      const w = await ownWorkflow(actor, req.params.wid);
      if (!w) return res.status(404).json({ error: "not found" });
      if (mutates && !isAdmin(actor)) return res.status(403).json({ error: "not allowed" });
      try {
        const out = await fn(w, (req.body ?? {}) as Record<string, unknown>, actor);
        if (out instanceof Conflict) return res.status(409).json(out.body);
        res.json(out ?? {});
      } catch (e) {
        if (e instanceof StaleDraft) return res.status(409).json({ error: "changed by someone else; reload" });
        if (e instanceof DirectoryError) return res.status(400).json({ error: e.message });
        throw e;
      }
    });

  // base is required: a save without it would skip the check that nobody else changed the draft
  router.post(
    "/workflows/:wid/draft",
    api(true, async (w, body, actor) => {
      if (typeof body.base !== "string") throw new DirectoryError("missing base; reload");
      return { base: await saveDraft(db, actor.tenantId, w.id, body.graph, body.base) };
    }),
  );

  router.post(
    "/workflows/:wid/publish",
    api(true, async (w, body, actor) => {
      const given = body.moves && typeof body.moves === "object" && !Array.isArray(body.moves) ? (body.moves as Record<string, unknown>) : {};
      const moves = Object.fromEntries(Object.entries(given).filter((e): e is [string, string] => typeof e[1] === "string"));
      const stranded = await runsOnRemovedNodes(db, actor.tenantId, w.id);
      if (stranded.some((s) => !(s.nodeId in moves))) {
        const live = await publishedGraph(db, w.id);
        return new Conflict({ stranded: stranded.map((s) => ({ nodeId: s.nodeId, label: live?.nodes.find((n) => n.id === s.nodeId)?.label ?? s.nodeId, runs: s.runIds.length })) });
      }
      return { version: await publish(db, actor.tenantId, w.id, actor.personId, moves, typeof body.base === "string" ? body.base : undefined) };
    }),
  );

  router.post("/workflows/:wid/discard", api(true, async (w, body, actor) => ({ base: await discardDraft(db, actor.tenantId, w.id, typeof body.base === "string" ? body.base : undefined) })));
  router.get("/workflows/:wid/versions", api(false, (w, _body, actor) => listVersions(db, actor.tenantId, w.id)));
  router.post(
    "/workflows/:wid/restore",
    api(true, async (w, body, actor) => {
      const version = Number(body.version);
      if (!Number.isInteger(version)) throw new DirectoryError("No such version");
      return { base: await restoreVersion(db, actor.tenantId, w.id, version, typeof body.base === "string" ? body.base : undefined) };
    }),
  );

  return router;
}

class Conflict {
  constructor(readonly body: unknown) {}
}
