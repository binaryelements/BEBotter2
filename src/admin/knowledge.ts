import { and, eq } from "drizzle-orm";
import express from "express";
import type { Request, Router } from "express";
import type { Db } from "../db/client.js";
import { botDefinitions, chats, people } from "../db/schema.js";
import { deleteNote, KnowledgeError, listNotes, noteHistory, readNote, rollbackNote, searchNotes, writeNote } from "../knowledge/store.js";
import { isAdmin } from "./access.js";
import { armedPage, isArmed } from "./arm.js";
import { html, layout, pageHead, scroll } from "./html.js";
import { adminOf, wrap } from "./http.js";
import { whenFor } from "./words.js";
import { page } from "./oidc.js";

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function knowledgeRoutes(db: Db, key: Buffer): Router {
  const router = express.Router();
  const bodyOf = (req: Request) => (req.body ?? {}) as Record<string, unknown>;

  router.get(
    "/knowledge",
    wrap(async (req, res) => {
      const { actor, csrf } = adminOf(res);
      const query = str(req.query.q).trim();
      const rows = query
        ? (await searchNotes(db, key, actor.tenantId, query, 100)).map((h) => ({ path: h.path, version: undefined, updatedAt: undefined }))
        : await listNotes(db, key, actor.tenantId);
      const when = await whenFor(db, actor.tenantId);
      const bots = await db.select({ id: botDefinitions.id, label: botDefinitions.label, displayName: botDefinitions.displayName }).from(botDefinitions).where(eq(botDefinitions.tenantId, actor.tenantId));
      const botName = new Map(bots.map((b) => [b.id, b.displayName ?? b.label]));
      const tr = rows.map(
        (n) => html`<tr><td><a href="/admin/knowledge/note?path=${encodeURIComponent(n.path)}">${n.path}</a></td><td>${"definitionId" in n && n.definitionId ? (botName.get(n.definitionId) ?? "a deleted bot") : "definitionId" in n ? html`<span class="muted">shared</span>` : ""}</td><td>${n.version ?? ""}</td><td>${when(n.updatedAt)}</td></tr>`,
      );
      res.type("html").send(
        layout({
          title: "Shared notes",
          body: html`${pageHead("Shared notes", isAdmin(actor) ? html`<a class="be-btn primary" href="#new-note">New note</a>` : undefined)}
<div class="toolbar"><form class="search-form" method="get" action="/admin/knowledge"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><input class="be-input" name="q" value="${query}" aria-label="Search" placeholder="Search notes…"><button class="be-btn">Search</button></form><div class="spacer"></div><span class="be-chip">${rows.length} ${rows.length === 1 ? "note" : "notes"}</span></div>
<section class="be-card">
${tr.length ? scroll(html`<table class="be-table"><thead><tr><th>Note</th><th>Bot</th><th>Version</th><th>Updated</th></tr></thead><tbody>${tr}</tbody></table>`) : html`<div class="be-empty"><b>No notes yet</b>Notes are the knowledge base a bot searches during a turn: its own, and the ones shared with everyone.${isAdmin(actor) ? html`<div style="margin-top:14px"><a class="be-btn primary" href="#new-note">Create the first note</a></div>` : ""}</div>`}
</section>
${isAdmin(actor) ? html`<section class="be-card" id="new-note"><div class="card-head"><h2>New note</h2></div><form class="new-note-form" method="get" action="/admin/knowledge/note"><div class="field"><label for="new-note-path">Path</label><input class="be-input" id="new-note-path" name="path" placeholder="troubleshooting/be-voice.md" aria-label="New note path"><div class="hint">Use a folder and a .md name, e.g. troubleshooting/be-voice.md.</div></div><button class="be-btn primary">Create note</button></form></section>` : ""}`,
          actor,
          csrf,
        }),
      );
    }),
  );

  router.get(
    "/knowledge/note",
    wrap(async (req, res) => {
      const { actor, csrf } = adminOf(res);
      const path = str(req.query.path);
      const admin = isAdmin(actor);
      const note = await readNote(db, key, actor.tenantId, path);
      if (!note && !admin) return page(res, 404, "Not found.");
      const history = await noteHistory(db, key, actor.tenantId, path);
      const [ppl, defs, cs] = await Promise.all([
        db.select({ id: people.id, name: people.name }).from(people).where(eq(people.tenantId, actor.tenantId)),
        db.select({ id: botDefinitions.id, label: botDefinitions.label }).from(botDefinitions).where(eq(botDefinitions.tenantId, actor.tenantId)),
        db.select({ id: chats.id, label: chats.label }).from(chats).where(eq(chats.tenantId, actor.tenantId)),
      ]);
      const person = new Map(ppl.map((p) => [p.id, p.name]));
      const bot = new Map(defs.map((d) => [d.id, d.label]));
      const chat = new Map(cs.map((c) => [c.id, c.label]));
      const field = (name: string, value: string) => html`<input type="hidden" name="${name}" value="${value}">`;
      const when = await whenFor(db, actor.tenantId);
      const tr = history.map((h) => {
        const who = (h.authorPersonId && person.get(h.authorPersonId)) || (h.authorDefinitionId && bot.get(h.authorDefinitionId)) || "—";
        const where = (h.chatId && chat.get(h.chatId)) || "—";
        const roll =
          admin && !h.deleted
            ? html`<form method="post" action="/admin/knowledge/rollback"><input type="hidden" name="csrf" value="${csrf}">${field("path", path)}${field("version", String(h.version))}<button class="be-btn sm">roll back</button></form>`
            : "";
        return html`<tr><td>${h.version}${h.deleted ? " (deleted)" : ""}</td><td>${who}</td><td>${where}</td><td>${when(h.createdAt)}</td><td>${roll}</td></tr>`;
      });
      res.type("html").send(
        layout({
          title: path,
          body: html`<header class="be-pagehead"><div class="pt"><nav class="crumb" aria-label="breadcrumb"><a href="/admin/knowledge">shared notes</a> / <span aria-current="page">${path}</span></nav><h1>${path}</h1><p class="meta">${note ? `version ${note.version}${history[0] ? ` · updated ${when(history[0].createdAt)}` : ""}` : "new note"}</p></div><div class="act"><a class="be-btn" href="/admin/knowledge">All notes</a></div></header>
${note && !admin ? html`<section class="be-card"><pre>${note.body}</pre></section>` : ""}
${admin
  ? html`<section class="be-card"><form method="post" action="/admin/knowledge/note"><input type="hidden" name="csrf" value="${csrf}">${field("path", path)}<div class="fields"><label>belongs to<span class="hint">a bot's own note is the only one it searches; shared is every bot</span><select class="be-select" name="bot"><option value="">shared with every bot</option>${defs.map((d) => html`<option value="${d.id}" ${d.id === note?.definitionId ? "selected" : ""}>${d.label}</option>`)}</select></label></div><textarea class="be-textarea" name="body" rows="18" aria-label="Note">${note?.body ?? ""}</textarea><div class="savebar"><span class="muted small">Every save keeps a version in the history below.</span><div class="spacer"></div><button class="be-btn primary">Save note</button></div></form>
${note ? html`<form method="post" action="/admin/knowledge/delete" style="margin-top:12px"><input type="hidden" name="csrf" value="${csrf}">${field("path", path)}<button class="be-btn danger">Delete note</button></form>` : ""}</section>`
  : ""}
<section class="be-card"><div class="card-head"><h2>History</h2><span class="be-chip">${history.length}</span></div>${scroll(html`<table class="be-table"><thead><tr><th>Version</th><th>Author</th><th>Chat</th><th>Time</th><th></th></tr></thead><tbody>${tr}</tbody></table>`)}</section>`,
          actor,
          csrf,
        }),
      );
    }),
  );

  const mutate = (route: string, run: (req: Request, tenantId: string, author: { personId: string }) => Promise<unknown>) =>
    router.post(
      route,
      wrap(async (req, res) => {
        const { actor } = adminOf(res);
        if (!isAdmin(actor)) return page(res, 403, "Not allowed.");
        if (route === "/knowledge/delete" && !isArmed(req)) return armedPage(req, res, { title: "Delete note?", button: "confirm delete?", back: `/admin/knowledge/note?path=${encodeURIComponent(str(bodyOf(req).path))}` });
        await run(req, actor.tenantId, { personId: actor.personId });
        const path = str(bodyOf(req).path);
        res.redirect(303, route === "/knowledge/delete" ? "/admin/knowledge" : `/admin/knowledge/note?path=${encodeURIComponent(path)}`);
      }),
    );

  mutate("/knowledge/note", async (req, t, a) => {
    const path = str(bodyOf(req).path);
    const existing = await readNote(db, key, t, path);
    const body = bodyOf(req) as Record<string, unknown>;
    // the form always carries it; without it, keep the note with whoever owns it now
    let owner = existing?.definitionId ?? undefined;
    if ("bot" in body) {
      const asked = str(body.bot);
      if (asked) {
        const [b] = await db.select({ id: botDefinitions.id }).from(botDefinitions).where(and(eq(botDefinitions.id, asked), eq(botDefinitions.tenantId, t)));
        if (!b) throw new KnowledgeError("Unknown bot");
        owner = b.id;
      } else owner = undefined;
    }
    return writeNote(db, key, t, path, str(bodyOf(req).body), { ...a, definitionId: owner });
  });
  mutate("/knowledge/rollback", (req, t, a) => rollbackNote(db, key, t, str(bodyOf(req).path), Number(bodyOf(req).version), a));
  mutate("/knowledge/delete", (req, t, a) => deleteNote(db, key, t, str(bodyOf(req).path), a));

  return router;
}
