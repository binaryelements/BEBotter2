import { eq } from "drizzle-orm";
import express from "express";
import type { Request, Router } from "express";
import type { Db } from "../db/client.js";
import { botDefinitions, chats, people } from "../db/schema.js";
import { deleteNote, listNotes, noteHistory, readNote, rollbackNote, searchNotes, writeNote } from "../knowledge/store.js";
import { isAdmin } from "./access.js";
import { html, layout } from "./html.js";
import { adminOf, wrap } from "./http.js";
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
      const tr = rows.map(
        (n) => html`<tr><td><a href="/admin/knowledge/note?path=${encodeURIComponent(n.path)}">${n.path}</a></td><td>${n.version ?? ""}</td><td>${n.updatedAt?.toISOString().slice(0, 16) ?? ""}</td></tr>`,
      );
      res.type("html").send(
        layout({
          title: "Knowledge",
          body: html`<h1>Knowledge</h1>
<form method="get" action="/admin/knowledge"><input name="q" value="${query}" aria-label="Search"> <button>Search</button></form>
<table><thead><tr><th>Note</th><th>Version</th><th>Updated</th></tr></thead><tbody>${tr}</tbody></table>
${isAdmin(actor) ? html`<form method="get" action="/admin/knowledge/note"><input name="path" placeholder="New note path" aria-label="New note path"> <button>New</button></form>` : ""}`,
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
      const tr = history.map((h) => {
        const who = (h.authorPersonId && person.get(h.authorPersonId)) || (h.authorDefinitionId && bot.get(h.authorDefinitionId)) || "—";
        const where = (h.chatId && chat.get(h.chatId)) || "—";
        const roll =
          admin && !h.deleted
            ? html`<form method="post" action="/admin/knowledge/rollback"><input type="hidden" name="csrf" value="${csrf}">${field("path", path)}${field("version", String(h.version))}<button>Roll back</button></form>`
            : "";
        return html`<tr><td>${h.version}${h.deleted ? " (deleted)" : ""}</td><td>${who}</td><td>${where}</td><td>${h.createdAt.toISOString().slice(0, 16)}</td><td>${roll}</td></tr>`;
      });
      res.type("html").send(
        layout({
          title: path,
          body: html`<h1>${path}</h1>
${note && !admin ? html`<pre>${note.body}</pre>` : ""}
${admin
  ? html`<form method="post" action="/admin/knowledge/note"><input type="hidden" name="csrf" value="${csrf}">${field("path", path)}<textarea name="body" rows="16" cols="80" aria-label="Note">${note?.body ?? ""}</textarea><br><button>Save</button></form>
${note ? html`<form method="post" action="/admin/knowledge/delete"><input type="hidden" name="csrf" value="${csrf}">${field("path", path)}<button>Delete</button></form>` : ""}`
  : ""}
<table><thead><tr><th>Version</th><th>Author</th><th>Chat</th><th>Time</th><th></th></tr></thead><tbody>${tr}</tbody></table>`,
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
