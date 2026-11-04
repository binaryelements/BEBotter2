import { eq } from "drizzle-orm";
import express from "express";
import type { Request, Router } from "express";
import type { Db } from "../db/client.js";
import { botDefinitions, chats, people } from "../db/schema.js";
import { deleteNote, listNotes, noteHistory, readNote, rollbackNote, searchNotes, writeNote } from "../knowledge/store.js";
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
      const tr = rows.map(
        (n) => html`<tr><td><a href="/admin/knowledge/note?path=${encodeURIComponent(n.path)}">${n.path}</a></td><td>${n.version ?? ""}</td><td>${when(n.updatedAt)}</td></tr>`,
      );
      res.type("html").send(
        layout({
          title: "Shared notes",
          body: html`${pageHead("Shared notes")}
<form class="row" method="get" action="/admin/knowledge"><input class="be-input" name="q" value="${query}" aria-label="Search" placeholder="search notes"> <button class="be-btn">search</button></form>
${tr.length ? scroll(html`<table class="be-table"><thead><tr><th>Note</th><th>Version</th><th>Updated</th></tr></thead><tbody>${tr}</tbody></table>`) : html`<div class="be-empty">No notes yet.</div>`}
${isAdmin(actor) ? html`<form class="row" method="get" action="/admin/knowledge/note"><input class="be-input" name="path" placeholder="new note path" aria-label="New note path"> <button class="be-btn primary">add note</button></form>` : ""}`,
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
          body: html`<header class="be-pagehead"><div class="pt"><nav class="crumb" aria-label="breadcrumb"><a href="/admin/knowledge">shared notes</a> / <span aria-current="page">${path}</span></nav><h1>${path}</h1></div></header>
${note && !admin ? html`<pre>${note.body}</pre>` : ""}
${admin
  ? html`<form method="post" action="/admin/knowledge/note"><input type="hidden" name="csrf" value="${csrf}">${field("path", path)}<textarea class="be-textarea" name="body" rows="16" aria-label="Note">${note?.body ?? ""}</textarea><p><button class="be-btn primary">save</button></p></form>
${note ? html`<form method="post" action="/admin/knowledge/delete"><input type="hidden" name="csrf" value="${csrf}">${field("path", path)}<button class="be-btn danger">delete</button></form>` : ""}`
  : ""}
${scroll(html`<table class="be-table"><thead><tr><th>Version</th><th>Author</th><th>Chat</th><th>Time</th><th></th></tr></thead><tbody>${tr}</tbody></table>`)}`,
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

  mutate("/knowledge/note", (req, t, a) => writeNote(db, key, t, str(bodyOf(req).path), str(bodyOf(req).body), a));
  mutate("/knowledge/rollback", (req, t, a) => rollbackNote(db, key, t, str(bodyOf(req).path), Number(bodyOf(req).version), a));
  mutate("/knowledge/delete", (req, t, a) => deleteNote(db, key, t, str(bodyOf(req).path), a));

  return router;
}
