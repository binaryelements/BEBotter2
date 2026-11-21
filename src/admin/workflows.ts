import express from "express";
import type { Request, Response, Router } from "express";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { getDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import type { BotDefinition, Workflow } from "../db/schema.js";
import { botDefinitions, people, workflowRuns, workflows } from "../db/schema.js";
import { DirectoryError } from "../org/directory.js";
import { createWorkflow, discardDraft, draftHash, listVersions, publish, publishedGraph, restoreVersion, runsOnRemovedNodes, saveDraft, StaleDraft } from "../workflows/store.js";
import type { Actor } from "./access.js";
import { isAdmin, mayEditPersona } from "./access.js";
import { href, html, layout, raw, scroll } from "./html.js";
import type { SafeHtml } from "./html.js";
import { adminOf, wrap } from "./http.js";
import { page } from "./oidc.js";

/** The bot's Workflows tab: its workflows with their runs, and the form that starts a new one. */
export async function workflowsSection(db: Db, def: BotDefinition, chats: { id: string; label: string }[], csrf: SafeHtml): Promise<SafeHtml> {
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
<form class="be-form" method="post" action="${base}">${csrf}<div class="fields"><label>name<input name="name" required maxlength="120"></label><label>chat<span class="hint">where it works and asks</span><select class="be-select" name="chatId">${chats.map((c) => html`<option value="${c.id}">${c.label}</option>`)}</select></label></div><button class="be-btn primary">new workflow</button></form>`;
}

export function workflowRoutes(db: Db): Router {
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
      const ppl = await db.select({ id: people.id, name: people.name }).from(people).where(eq(people.tenantId, actor.tenantId)).orderBy(asc(people.name));
      const init = { workflowId: w.id, name: w.name, draft: w.draft, base: draftHash(w.draft), published: w.publishedVersion !== null, people: ppl, csrf, readOnly: !isAdmin(actor) };
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
      return { version: await publish(db, actor.tenantId, w.id, actor.personId, moves) };
    }),
  );

  router.post("/workflows/:wid/discard", api(true, (w, _body, actor) => discardDraft(db, actor.tenantId, w.id)));
  router.get("/workflows/:wid/versions", api(false, (w, _body, actor) => listVersions(db, actor.tenantId, w.id)));
  router.post(
    "/workflows/:wid/restore",
    api(true, async (w, body, actor) => {
      const version = Number(body.version);
      if (!Number.isInteger(version)) throw new DirectoryError("No such version");
      await restoreVersion(db, actor.tenantId, w.id, version);
    }),
  );

  return router;
}

class Conflict {
  constructor(readonly body: unknown) {}
}
