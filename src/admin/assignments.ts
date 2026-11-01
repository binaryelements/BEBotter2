import { desc, eq, sql } from "drizzle-orm";
import express from "express";
import type { Request, Router } from "express";
import { listDefinitions, setChatDefinition, setChatLabel } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { chatAssignments, chats } from "../db/schema.js";
import { isAdmin } from "./access.js";
import { html, layout, pageHead, scroll } from "./html.js";
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
      const [defs, rows] = await Promise.all([
        listDefinitions(db, actor.tenantId),
        db
          .select({ id: chats.id, type: chats.conversationType, label: chats.label, lastSeenAt: chats.lastSeenAt, definitionId: chatAssignments.definitionId })
          .from(chats)
          .leftJoin(chatAssignments, eq(chatAssignments.chatId, chats.id))
          .where(eq(chats.tenantId, actor.tenantId))
          .orderBy(sql`${chats.lastSeenAt} desc nulls last`, desc(chats.createdAt)),
      ]);
      const csrfField = html`<input type="hidden" name="csrf" value="${csrf}">`;
      const body = rows.map((c) => {
        const url = `/admin/assignments/${encodeURIComponent(c.id)}`;
        return html`<tr><td><form class="inline-edit" method="post" action="${url}/label">${csrfField}<input class="be-input" name="label" value="${c.label ?? ""}" placeholder="${c.id.slice(-12)}" maxlength="80" aria-label="Label"> <button class="be-btn sm">save</button></form></td>
<td>${c.type}</td><td>${c.lastSeenAt?.toISOString() ?? ""}</td>
<td><form class="inline-edit" method="post" action="${url}">${csrfField}<select class="be-select" name="definitionId" aria-label="Bot"><option value="">none</option>${defs.map((d) => html`<option value="${d.id}" ${d.id === c.definitionId ? "selected" : ""}>${d.label}</option>`)}</select> <button class="be-btn sm">save</button></form></td></tr>`;
      });
      res.type("html").send(layout({ title: "Assignments", body: html`${pageHead("Assignments")}${
        rows.length ? scroll(html`<table class="be-table"><thead><tr><th>Chat</th><th>Type</th><th>Last seen</th><th>Bot</th></tr></thead><tbody>${body}</tbody></table>`) : html`<div class="be-empty">No chats yet.</div>`
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
