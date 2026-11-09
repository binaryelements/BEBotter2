import express from "express";
import type { Router } from "express";
import { and, count, desc, eq, inArray, max } from "drizzle-orm";
import { clearPersonalChat, ensurePersonalAssistant, listDefinitions, updateDefinitionFields } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { assistantRequests, auditEvents, botDefinitions, chatAssignments, people } from "../db/schema.js";
import { setPersonalBot } from "../org/directory.js";
import { countOpenTodos } from "../todos/store.js";
import { isAdmin } from "./access.js";
import { html, layout, pageHead, scroll } from "./html.js";
import { adminOf, wrap } from "./http.js";
import { page } from "./oidc.js";
import { whenFor } from "./words.js";

/** The company's personal assistants: one per allowed person, each private to its owner. */
export function assistantRoutes(db: Db, defaultModel: string): Router {
  const router = express.Router();
  const deny = (res: express.Response) => page(res, 403, "Not allowed.");

  router.get(
    "/assistants",
    wrap(async (_req, res) => {
      const { actor, csrf } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      const defs = (await listDefinitions(db, actor.tenantId)).filter((d) => d.identity === "person");
      const owners = await db.select({ id: people.id, name: people.name, on: people.personalBot }).from(people).where(eq(people.tenantId, actor.tenantId));
      const owner = new Map(owners.map((p) => [p.id, p]));
      const ids = defs.map((d) => d.id);
      const [chats, last] = await Promise.all([
        ids.length ? db.select({ id: chatAssignments.definitionId, n: count() }).from(chatAssignments).where(inArray(chatAssignments.definitionId, ids)).groupBy(chatAssignments.definitionId) : [],
        ids.length
          ? db.select({ id: auditEvents.definitionId, at: max(auditEvents.startedAt) }).from(auditEvents).where(and(eq(auditEvents.tenantId, actor.tenantId), inArray(auditEvents.definitionId, ids))).groupBy(auditEvents.definitionId)
          : [],
      ]);
      const chatCount = new Map(chats.map((c) => [c.id, Number(c.n)]));
      const lastAt = new Map(last.map((l) => [l.id, l.at]));
      const requests = await db
        .select()
        .from(assistantRequests)
        .where(and(eq(assistantRequests.tenantId, actor.tenantId), eq(assistantRequests.status, "pending")))
        .orderBy(desc(assistantRequests.createdAt))
        .limit(20);
      const when = await whenFor(db, actor.tenantId);
      const todoCount = await countOpenTodos(db, actor.tenantId, defs.flatMap((d) => (d.ownerPersonId ? [d.ownerPersonId] : [])));
      const card = (d: (typeof defs)[number]) => {
        const o = d.ownerPersonId ? owner.get(d.ownerPersonId) : undefined;
        const on = !!o?.on;
        const n = chatCount.get(d.id) ?? 0;
        const h = [...d.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
        const initials = (d.displayName ?? d.label).split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
        const persona = d.persona.replace(/\s+/g, " ").trim();
        return html`<section class="be-card bot-card">
<div class="bot-head"><div class="bot-avatar" style="background:hsl(${h} 45% 22%);color:hsl(${h} 80% 85%)">${initials}</div><div class="bot-title"><div class="bot-name">${d.displayName ?? d.label}</div><div class="bot-role">${o ? `for ${o.name}` : "no owner"}</div></div><span class="be-chip ${on ? "g" : ""}">${on ? "on" : "off"}</span></div>
<p class="bot-desc clamp">${persona}</p>
<form class="assistant-name" method="post" action="/admin/assistants/${d.id}/name" data-autosave><input type="hidden" name="csrf" value="${csrf}">
<label>name<span class="hint">shown in chat; blank means “My assistant”</span><input class="be-input" name="displayName" value="${d.displayName ?? ""}" placeholder="${d.label}" maxlength="60" autocomplete="off"></label><button class="be-btn sm auto">save</button>
</form>
<div class="bot-chips"><span class="be-chip c">${d.model}</span><span class="be-chip">${n} ${n === 1 ? "chat" : "chats"}</span>${d.ownerPersonId ? html`<span class="be-chip">${todoCount.get(d.ownerPersonId) ?? 0} ${(todoCount.get(d.ownerPersonId) ?? 0) === 1 ? "to-do" : "to-dos"}</span>` : ""}${lastAt.get(d.id) ? html`<span class="be-chip">last ${when(lastAt.get(d.id))}</span>` : ""}</div>
<div class="bot-foot"><form method="post" action="/admin/assistants/${d.id}/enabled" data-autosave><input type="hidden" name="csrf" value="${csrf}"><label class="be-toggle"><input type="checkbox" name="enabled" ${on ? "checked" : ""}> ${on ? "on" : "off"}</label><button class="be-btn sm auto">save</button></form><a class="be-btn sm" href="/admin/bots/${d.id}/try">Try it</a><a class="be-btn sm primary" href="/admin/bots/${d.id}">Open</a></div>
</section>`;
      };
      const body = html`${pageHead("Personal assistants", html`<a class="be-btn" href="/admin/people">Who can have one</a>`)}
<div class="be-notice"><div class="grow"><b>One assistant per person, only for people you allow</b><div class="meta">Turn on the assistant switch on the People page to allow someone. Their assistant is private to them: it only answers in their own chat and never sees another person's mail, calendar or files.</div></div></div>
${defs.length ? html`<div class="bot-grid">${defs.map(card)}</div>` : html`<div class="be-empty"><b>No personal assistants yet</b>Allow someone on the People page and their assistant appears here.<div style="margin-top:14px"><a class="be-btn primary" href="/admin/people">Open People</a></div></div>`}
<section class="be-card section"><div class="card-head"><h2>Requests waiting</h2><span class="be-chip">${requests.length}</span></div>
${requests.length ? scroll(html`<table class="be-table"><thead><tr><th>From</th><th>To</th><th>Kind</th><th>Request</th><th>When</th></tr></thead><tbody>${requests.map((r) => html`<tr><td>${owner.get(r.fromPersonId)?.name ?? ""}</td><td>${owner.get(r.toPersonId)?.name ?? ""}</td><td>${r.kind}</td><td>${r.body}</td><td>${when(r.createdAt)}</td></tr>`)}</tbody></table>`) : html`<div class="be-empty">No requests waiting.</div>`}
</section>`;
      res.type("html").send(layout({ title: "Personal assistants", body, actor, csrf }));
    }),
  );

  router.post(
    "/assistants/:id/enabled",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      const [def] = await db.select().from(botDefinitions).where(and(eq(botDefinitions.id, req.params.id), eq(botDefinitions.tenantId, actor.tenantId)));
      if (!def || def.identity !== "person" || !def.ownerPersonId) return page(res, 404, "Assistant not found.");
      const on = (req.body as Record<string, unknown> | undefined)?.enabled === "on";
      await setPersonalBot(db, actor.tenantId, def.ownerPersonId, on);
      if (on) await ensurePersonalAssistant(db, actor.tenantId, def.ownerPersonId, defaultModel);
      else await clearPersonalChat(db, actor.tenantId, def.ownerPersonId);
      res.redirect(303, "/admin/assistants");
    }),
  );

  router.post(
    "/assistants/:id/name",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      const [def] = await db.select().from(botDefinitions).where(and(eq(botDefinitions.id, req.params.id), eq(botDefinitions.tenantId, actor.tenantId)));
      if (!def || def.identity !== "person") return page(res, 404, "Assistant not found.");
      const displayName = String((req.body as Record<string, unknown> | undefined)?.displayName ?? "").trim();
      await updateDefinitionFields(db, actor.tenantId, def.id, {
        label: def.label,
        persona: def.persona,
        model: def.model,
        webSearch: def.webSearch,
        computer: def.computer,
        displayName,
      });
      res.redirect(303, "/admin/assistants");
    }),
  );

  return router;
}
