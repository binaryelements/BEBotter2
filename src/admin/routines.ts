import { and, eq } from "drizzle-orm";
import express from "express";
import type { Router } from "express";
import { listDefinitions } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { chats, routines } from "../db/schema.js";
import { nextRun } from "../routines/cron.js";
import { deleteRoutine, listRoutines, updateRoutine } from "../routines/store.js";
import { DirectoryError } from "../org/directory.js";
import { getTenantSettings } from "../org/org.js";
import { isAdmin } from "./access.js";
import { html, layout, pageHead, scroll } from "./html.js";
import { adminOf, wrap } from "./http.js";
import { page } from "./oidc.js";
import { cronWords, whenFor } from "./words.js";
import { visibleBots } from "./overview.js";
import { liveTurns } from "../engine/live.js";
import type { SafeHtml } from "./html.js";

/** Everything a bot runs on a timer or in the background, across every chat the person may see. */
const chatNames = async (db: Db, tenantId: string) =>
  new Map(
    (await db.select({ id: chats.id, label: chats.label, type: chats.conversationType }).from(chats).where(eq(chats.tenantId, tenantId))).map(
      (c) => [c.id, c.label ?? (c.type === "personal" ? "one-to-one" : c.id.slice(0, 18))],
    ),
  );

const since = (at: Date, now: Date) => {
  const s = Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

/** The turns working right now on bots this person can see; the page swaps it for a fresh copy every 10 seconds. */
function runningBox(tenantId: string, bot: Map<string, string>, chatName: Map<string, string>): SafeHtml {
  const now = new Date();
  const rows = liveTurns(tenantId).filter((t) => bot.has(t.definitionId));
  const tr = rows.map(
    (t) =>
      html`<tr><td>${bot.get(t.definitionId) ?? ""}</td><td class="muted">${chatName.get(t.chatId) ?? ""}</td><td>${t.startedBy}</td><td class="be-mono be-nowrap">${since(t.startedAt, now)}</td><td>${t.doing ?? html`<span class="muted">thinking</span>`}${t.steps > 1 ? html` <span class="muted">(step ${t.steps})</span>` : ""}</td><td>${t.waiting ? html`<span class="be-chip">confirmation</span>` : ""}</td></tr>`,
  );
  return html`<section class="be-card" data-refresh="/admin/routines/running">
<div class="card-head"><h2>Running now</h2><span class="be-chip ${rows.length ? "c" : ""}">${rows.length}</span></div>
${tr.length ? scroll(html`<table class="be-table"><thead><tr><th>Bot</th><th>Chat</th><th>Started by</th><th>For</th><th>Doing now</th><th>Waiting on</th></tr></thead><tbody>${tr}</tbody></table>`) : html`<p class="muted small">Nothing running right now.</p>`}
</section>`;
}

export function routineRoutes(db: Db): Router {
  const router = express.Router();
  const deny = (res: express.Response) => page(res, 403, "Not allowed.");

  router.get(
    "/routines",
    wrap(async (_req, res) => {
      const { actor, csrf } = adminOf(res);
      const admin = isAdmin(actor);
      const { defs } = await visibleBots(db, actor);
      const ids = new Set(defs.map((d) => d.id));
      const rows = (await listRoutines(db, actor.tenantId)).filter((r) => ids.has(r.definitionId));
      const [chatName, timezone] = await Promise.all([chatNames(db, actor.tenantId), getTenantSettings(db, actor.tenantId).then((s) => s.timezone)]);
      const bot = new Map(defs.map((d) => [d.id, d.displayName ?? d.label]));
      const when = await whenFor(db, actor.tenantId);
      const now = new Date();
      const next = (r: (typeof rows)[number]) => (r.schedule ? nextRun(r.schedule, timezone, now) : r.runAt);
      const state = (r: (typeof rows)[number]) =>
        !r.enabled ? html`<span class="be-chip">paused</span>` : r.schedule ? html`<span class="be-chip g">scheduled</span>` : r.background ? html`<span class="be-chip c">background</span>` : html`<span class="be-chip">once</span>`;
      const sorted = [...rows].sort((a, b) => {
        const an = next(a)?.getTime() ?? Number.MAX_SAFE_INTEGER;
        const bn = next(b)?.getTime() ?? Number.MAX_SAFE_INTEGER;
        return an - bn;
      });
      const tr = sorted.map((r) => {
        const at = next(r);
        const act = (path: string, label: string, cls = "") =>
          admin ? html`<form method="post" action="/admin/routines/${r.id}/${path}">${csrf}<button class="be-btn sm ${cls}">${label}</button></form>` : "";
        return html`<tr><td><div class="name">${r.prompt.length > 90 ? `${r.prompt.slice(0, 90)}…` : r.prompt}</div></td><td>${bot.get(r.definitionId) ?? ""}</td><td class="muted">${chatName.get(r.chatId) ?? ""}</td><td>${r.schedule ? cronWords(r.schedule) : r.background ? "runs once, beside the chat" : "once"}</td><td>${at ? when(at) : r.schedule ? html`<span class="muted">not in the next week</span>` : ""}</td><td class="muted">${r.lastRunAt ? when(r.lastRunAt) : "never"}</td><td>${state(r)}</td><td><div class="conn-actions">${admin ? html`${act("run", "run now")}${act("enabled", r.enabled ? "pause" : "resume")}${act("delete", "delete", "danger")}` : ""}</div></td></tr>`;
      });
      const recurring = rows.filter((r) => r.schedule).length;
      const res_ = html`${pageHead("Routines", admin ? html`<a class="be-btn" href="/admin/bots">Manage on a bot</a>` : undefined)}
<p class="muted small">Everything a bot runs on a timer or in the background, across every chat you can see. A routine runs with nobody watching: reads are free, writes wait for a card nobody can answer unless an admin has granted them.</p>
${runningBox(actor.tenantId, bot, chatName)}
<section class="be-card">
<div class="card-head"><h2>Routines</h2><span class="be-chip">${recurring} recurring · ${rows.length - recurring} one-off</span></div>
${tr.length ? scroll(html`<table class="be-table"><thead><tr><th>What it does</th><th>Bot</th><th>Chat</th><th>When</th><th>Next</th><th>Last</th><th>State</th><th></th></tr></thead><tbody>${tr}</tbody></table>`) : html`<div class="be-empty"><b>No routines yet</b>A bot can schedule one in chat (“sweep the fleet at 7am”), or an admin can add one on a bot's Routines tab.</div>`}
</section>`;
      res.type("html").send(layout({ title: "Routines", body: res_, actor, csrf }));
    }),
  );

  // the Running now box alone, for the page's 10-second refresh
  router.get(
    "/routines/running",
    wrap(async (_req, res) => {
      const { actor } = adminOf(res);
      const { defs } = await visibleBots(db, actor);
      const bot = new Map(defs.map((d) => [d.id, d.displayName ?? d.label]));
      res.type("html").send(String(runningBox(actor.tenantId, bot, await chatNames(db, actor.tenantId))));
    }),
  );

  // an admin's three verbs: run it on the next tick, pause or resume the schedule, or remove it
  const act = (path: string, run: (tenantId: string, id: string) => Promise<unknown>) =>
    router.post(
      `/routines/:id/${path}`,
      wrap(async (req, res) => {
        const { actor } = adminOf(res);
        if (!isAdmin(actor)) return deny(res);
        await run(actor.tenantId, req.params.id);
        res.redirect(303, "/admin/routines");
      }),
    );

  act("run", async (tenantId, id) => {
    const rows = await db
      .update(routines)
      .set({ runAt: new Date(Date.now() + 1000), lastRunAt: null, enabled: true })
      .where(and(eq(routines.id, id), eq(routines.tenantId, tenantId)))
      .returning({ id: routines.id });
    if (!rows.length) throw new DirectoryError("Routine not found");
  });

  act("enabled", async (tenantId, id) => {
    const [r] = await db.select({ enabled: routines.enabled }).from(routines).where(and(eq(routines.id, id), eq(routines.tenantId, tenantId)));
    if (!r) throw new DirectoryError("Routine not found");
    await updateRoutine(db, tenantId, id, { enabled: !r.enabled });
  });

  act("delete", async (tenantId, id) => {
    await deleteRoutine(db, tenantId, id);
  });

  return router;
}
