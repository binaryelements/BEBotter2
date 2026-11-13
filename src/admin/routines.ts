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

/** Everything a bot runs on a timer or in the background, across every chat the person may see. */
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
      const [chatRows, timezone] = await Promise.all([
        db.select({ id: chats.id, label: chats.label, type: chats.conversationType }).from(chats).where(eq(chats.tenantId, actor.tenantId)),
        getTenantSettings(db, actor.tenantId).then((s) => s.timezone),
      ]);
      const chatName = new Map(chatRows.map((c) => [c.id, c.label ?? (c.type === "personal" ? "one-to-one" : c.id.slice(0, 18))]));
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
<section class="be-card">
<div class="card-head"><h2>Routines</h2><span class="be-chip">${recurring} recurring · ${rows.length - recurring} one-off</span></div>
${tr.length ? scroll(html`<table class="be-table"><thead><tr><th>What it does</th><th>Bot</th><th>Chat</th><th>When</th><th>Next</th><th>Last</th><th>State</th><th></th></tr></thead><tbody>${tr}</tbody></table>`) : html`<div class="be-empty"><b>No routines yet</b>A bot can schedule one in chat (“sweep the fleet at 7am”), or an admin can add one on a bot's Routines tab.</div>`}
</section>`;
      res.type("html").send(layout({ title: "Routines", body: res_, actor, csrf }));
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
