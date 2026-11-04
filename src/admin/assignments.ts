import { and, desc, eq, sql } from "drizzle-orm";
import express from "express";
import type { Request, Router } from "express";
import { listDefinitions, setChatDefinition, setChatLabel } from "../bots/definitions.js";
import { setChatListening } from "../teams/overheard.js";
import type { Db } from "../db/client.js";
import { auditEvents, chatAssignments, chats, people } from "../db/schema.js";
import { isAdmin } from "./access.js";
import { AUTO, html, layout, pageHead, scroll } from "./html.js";
import { chatTypeWords, whenFor } from "./words.js";
import { adminOf, wrap } from "./http.js";
import { page } from "./oidc.js";

const field = (req: Request, name: string) => {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof v === "string" ? v : "";
};

export function assignmentRoutes(db: Db): Router {
  const router = express.Router();

  router.get(
    "/assignments",
    wrap(async (_req, res) => {
      const { actor, csrf } = adminOf(res);
      if (!isAdmin(actor)) return page(res, 403, "Not allowed.");
      const when = await whenFor(db, actor.tenantId);
      const [defs, rows, talkers] = await Promise.all([
        listDefinitions(db, actor.tenantId),
        db
          .select({ id: chats.id, type: chats.conversationType, label: chats.label, lastSeenAt: chats.lastSeenAt, listening: chats.listening, definitionId: chatAssignments.definitionId, owner: people.name })
          .from(chats)
          .leftJoin(chatAssignments, eq(chatAssignments.chatId, chats.id))
          .leftJoin(people, eq(people.id, chats.ownerPersonId))
          .where(eq(chats.tenantId, actor.tenantId))
          .orderBy(sql`${chats.lastSeenAt} desc nulls last`, desc(chats.createdAt)),
        // who has spoken in each chat, from the messages recorded there
        db
          .select({ chatId: auditEvents.chatId, names: sql<string>`string_agg(distinct ${people.name}, ', ')` })
          .from(auditEvents)
          .innerJoin(people, eq(people.id, auditEvents.personId))
          .where(and(eq(auditEvents.tenantId, actor.tenantId), eq(auditEvents.kind, "message")))
          .groupBy(auditEvents.chatId),
      ]);
      const who = new Map(talkers.map((t) => [t.chatId, t.names]));
      const csrfField = html`<input type="hidden" name="csrf" value="${csrf}">`;
      const body = rows.map((c) => {
        const url = `/admin/assignments/${encodeURIComponent(c.id)}`;
        return html`<tr><td><form class="inline-edit" method="post" action="${url}/label" data-autosave>${csrfField}${AUTO}<input class="be-input" name="label" value="${c.label ?? ""}" placeholder="a name for this chat" maxlength="80" aria-label="Name"> <button class="be-btn sm auto">save</button></form></td>
<td>${chatTypeWords(c.type)}</td><td>${c.type === "personal" ? (c.owner ?? "") : (who.get(c.id) ?? "")}</td><td>${when(c.lastSeenAt)}</td>
<td>${c.type === "personal" ? "" : html`<form class="inline-edit" method="post" action="${url}/listening" data-autosave>${csrfField}${AUTO}<input type="hidden" name="listening" value="${c.listening ? "off" : "on"}"><label class="be-toggle" title="${c.listening ? "the bot keeps what the chat says as context for when it is asked something; untick to stop" : "the bot only sees messages that mention it; tick to let it listen"}"><input type="checkbox" ${c.listening ? "checked" : ""} aria-label="listening"> listening</label> <button class="be-btn sm auto">${c.listening ? "stop" : "start"}</button></form>`}</td>
<td><form class="inline-edit" method="post" action="${url}" data-autosave>${csrfField}${AUTO}<select class="be-select" name="definitionId" aria-label="Bot"><option value="">none</option>${defs.filter((d) => c.type === "personal" || d.identity !== "person").map((d) => html`<option value="${d.id}" ${d.id === c.definitionId ? "selected" : ""}>${d.displayName ? `${d.displayName} · ${d.label}` : d.label}</option>`)}</select> <button class="be-btn sm auto">save</button></form></td></tr>`;
      });
      res.type("html").send(layout({ title: "Assignments", body: html`${pageHead("Assignments")}${
        rows.length ? scroll(html`<table class="be-table"><thead><tr><th>Chat</th><th>Type</th><th>Who</th><th>Last seen</th><th>Listens</th><th>Bot</th></tr></thead><tbody>${body}</tbody></table>`) : html`<div class="be-empty">No chats yet.</div>`
      }`, actor, csrf }));
    }),
  );

  router.post(
    "/assignments/:chatId",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return page(res, 403, "Not allowed.");
      await setChatDefinition(db, actor.tenantId, req.params.chatId, field(req, "definitionId") || null);
      res.redirect(303, "/admin/assignments");
    }),
  );

  router.post(
    "/assignments/:chatId/listening",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return page(res, 403, "Not allowed.");
      await setChatListening(db, actor.tenantId, req.params.chatId, field(req, "listening") === "on");
      res.redirect(303, "/admin/assignments");
    }),
  );

  router.post(
    "/assignments/:chatId/label",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return page(res, 403, "Not allowed.");
      await setChatLabel(db, actor.tenantId, req.params.chatId, field(req, "label"));
      res.redirect(303, "/admin/assignments");
    }),
  );

  return router;
}
