import express from "express";
import type { Request, Router } from "express";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { people, todos } from "../db/schema.js";
import { DirectoryError } from "../org/directory.js";
import { addTodo, completeTodo, deleteTodo } from "../todos/store.js";
import { isAdmin } from "./access.js";
import { html, layout, pageHead, scroll } from "./html.js";
import { adminOf, wrap } from "./http.js";
import { page } from "./oidc.js";
import { whenFor } from "./words.js";

const field = (req: Request, name: string) => {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof v === "string" ? v.trim() : "";
};

/** The company's personal to-dos. The PA is the person-facing way in; this page is for admins. */
export function todoRoutes(db: Db): Router {
  const router = express.Router();
  const deny = (res: express.Response) => page(res, 403, "Not allowed.");

  router.get(
    "/todos",
    wrap(async (req, res) => {
      const { actor, csrf } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      const person = typeof req.query.person === "string" ? req.query.person : "";
      const status = req.query.status === "done" ? "done" : req.query.status === "all" ? "" : "open";
      const roster = await db.select({ id: people.id, name: people.name }).from(people).where(eq(people.tenantId, actor.tenantId)).orderBy(asc(people.name));
      const conditions = [eq(todos.tenantId, actor.tenantId)];
      if (person) conditions.push(eq(todos.personId, person));
      if (status) conditions.push(eq(todos.status, status));
      const rows = await db
        .select({ todo: todos, personName: people.name })
        .from(todos)
        .innerJoin(people, eq(people.id, todos.personId))
        .where(and(...conditions))
        .orderBy(asc(sql`case when ${todos.status} = 'done' then 1 else 0 end`), asc(todos.dueAt), desc(todos.createdAt))
        .limit(200);
      const when = await whenFor(db, actor.tenantId);
      const open = rows.filter((r) => r.todo.status === "open").length;
      const row = (r: (typeof rows)[number]) => html`<tr>
<td>${r.personName}</td>
<td><b>${r.todo.title}</b>${r.todo.details ? html`<div class="muted small">${r.todo.details}</div>` : ""}</td>
<td>${r.todo.dueAt ? when(r.todo.dueAt) : "—"}</td>
<td><span class="be-chip ${r.todo.status === "done" ? "g" : "w"}">${r.todo.status}</span></td>
<td>${r.todo.definitionId ? "assistant" : "admin"}</td>
<td><form class="inline-edit" method="post" action="/admin/todos/${r.todo.id}/done"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="done" value="${r.todo.status === "done" ? "off" : "on"}"><button class="be-btn sm">${r.todo.status === "done" ? "reopen" : "done"}</button></form><form class="inline-edit" method="post" action="/admin/todos/${r.todo.id}/delete"><input type="hidden" name="csrf" value="${csrf}"><button class="be-btn sm danger">delete</button></form></td>
</tr>`;
      const body = html`${pageHead("To-dos", html`<a class="be-btn primary" href="#add-todo" onclick="var i=document.getElementById('todo-title'); if(i) i.focus();">Add a to-do</a>`)}
<p class="muted">The personal to-do list. A person's assistant can add, list and complete these in chat; this page is the admin view.</p>
<div class="toolbar"><form method="get" action="/admin/todos" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><select class="be-select" name="person" aria-label="Person"><option value="">any person</option>${roster.map((p) => html`<option value="${p.id}" ${p.id === person ? "selected" : ""}>${p.name}</option>`)}</select><select class="be-select" name="status" aria-label="Status"><option value="open" ${status === "open" ? "selected" : ""}>open</option><option value="done" ${status === "done" ? "selected" : ""}>done</option><option value="all" ${status === "" ? "selected" : ""}>all</option></select><button class="be-btn">filter</button></form><div class="spacer"></div><span class="be-chip">${open} open</span></div>
<section class="be-card">
<div class="card-head"><h2>To-dos</h2><span class="be-chip">${rows.length}</span></div>
${rows.length ? scroll(html`<table class="be-table"><thead><tr><th>Person</th><th>To-do</th><th>Due</th><th>Status</th><th>Created by</th><th></th></tr></thead><tbody>${rows.map(row)}</tbody></table>`) : html`<div class="be-empty">Nothing here.</div>`}
</section>
<section class="be-card section" id="add-todo"><div class="card-head"><h2>Add a to-do</h2></div>
<form method="post" action="/admin/todos"><input type="hidden" name="csrf" value="${csrf}"><div class="form-grid"><div class="field"><label for="todo-person">Person</label><select id="todo-person" class="be-select" name="personId">${roster.map((p) => html`<option value="${p.id}" ${p.id === person ? "selected" : ""}>${p.name}</option>`)}</select></div><div class="field"><label for="todo-due">Due</label><input id="todo-due" class="be-input" type="date" name="dueAt"></div><div class="field wide"><label for="todo-title">To-do</label><input id="todo-title" class="be-input" name="title" required maxlength="200"></div><div class="field wide"><label for="todo-details">Details</label><textarea id="todo-details" class="be-textarea" name="details" rows="3" maxlength="4000"></textarea></div></div><div class="savebar"><span class="muted small">The person's assistant can also add and complete these in chat.</span><div class="spacer"></div><button class="be-btn primary">Add to-do</button></div></form>
</section>`;
      res.type("html").send(layout({ title: "To-dos", body, actor, csrf }));
    }),
  );

  router.post(
    "/todos",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      const personId = field(req, "personId");
      if (!personId) throw new DirectoryError("Choose a person");
      const [p] = await db.select({ id: people.id }).from(people).where(and(eq(people.id, personId), eq(people.tenantId, actor.tenantId)));
      if (!p) throw new DirectoryError("Person not found");
      await addTodo(db, { tenantId: actor.tenantId, personId, title: field(req, "title"), details: field(req, "details") || undefined, dueAt: field(req, "dueAt") || undefined });
      res.redirect(303, `/admin/todos?person=${encodeURIComponent(personId)}`);
    }),
  );

  router.post(
    "/todos/:id/done",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      const [row] = await db.select({ personId: todos.personId }).from(todos).where(and(eq(todos.id, req.params.id), eq(todos.tenantId, actor.tenantId)));
      if (!row) return page(res, 404, "To-do not found.");
      await completeTodo(db, actor.tenantId, row.personId, req.params.id, field(req, "done") === "on");
      res.redirect(303, "/admin/todos");
    }),
  );

  router.post(
    "/todos/:id/delete",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      const [row] = await db.select({ personId: todos.personId }).from(todos).where(and(eq(todos.id, req.params.id), eq(todos.tenantId, actor.tenantId)));
      if (!row) return page(res, 404, "To-do not found.");
      await deleteTodo(db, actor.tenantId, row.personId, req.params.id);
      res.redirect(303, "/admin/todos");
    }),
  );

  return router;
}
