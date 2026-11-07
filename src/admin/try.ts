import express from "express";
import type { Request, Response, Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { getDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { auditEvents, people, sessions } from "../db/schema.js";
import type { Confirmations } from "../engine/confirm.js";
import type { ProgressEvent, RunResult, RunTurnInput } from "../engine/runner.js";
import { DirectoryError, listPeople } from "../org/directory.js";
import { recordChatOwner, upsertChat } from "../org/org.js";
import { toolLabel } from "../teams/cards.js";
import { isAdmin, mayUseDefinition } from "./access.js";
import { html, layout, raw } from "./html.js";
import { adminOf, wrap } from "./http.js";
import { page } from "./oidc.js";
import { whenFor } from "./words.js";

export type TryDeps = { db: Db; runTurn?: (t: RunTurnInput) => Promise<RunResult>; confirmations?: Confirmations };

const MARK = "<!--reply-->";
// actionId is a UUID the server made, so it is safe inside the script
const CONFIRM_SCRIPT = (actionId: string) =>
  `<script>(function(){var f=document.getElementById("c-${actionId}");f.addEventListener("submit",function(e){e.preventDefault();var b=new URLSearchParams(new FormData(f));b.set("answer",e.submitter.value);fetch(f.action,{method:"POST",body:b}).then(function(r){return r.text()}).then(function(t){f.textContent=t});});})()</script>`;
const MAX_TEXT = 4000;
const field = (req: Request, name: string) => {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof v === "string" ? v : "";
};
/** The test chat for one bot and one person: its own memory, apart from any Teams chat. */
export const tryChatId = (definitionId: string, personId: string) => `test:${definitionId}:${personId}`;

// the role as the person select shows it: "Hal · head of Sales", "Ann · admin"
const roleWords = (p: { role: string; memberships: { departmentName: string; isHead: boolean }[] }) => {
  const heads = p.memberships.filter((m) => m.isHead).map((m) => m.departmentName);
  const depts = p.memberships.filter((m) => !m.isHead).map((m) => m.departmentName);
  return [p.role === "admin" ? "admin" : "", heads.length ? `head of ${heads.join(", ")}` : "", depts.join(", ")].filter(Boolean).join(" · ") || "user";
};

/** An admin talks to a bot as any person, on the admin site: the same bot, the same rules, with the reply streamed into the page. */
export function tryRoutes(deps: TryDeps): Router {
  const { db } = deps;
  const router = express.Router();

  const load = async (res: Response, id: string, personId: string) => {
    const { actor } = adminOf(res);
    const def = await getDefinition(db, actor.tenantId, id);
    if (!def) throw new DirectoryError("Bot not found");
    const everyone = await listPeople(db, actor.tenantId);
    const person = everyone.find((p) => p.id === (personId || actor.personId));
    if (!person) throw new DirectoryError("Person not found");
    return { actor, def, everyone, person, may: await mayUseDefinition(db, actor.tenantId, person.id, def.id) };
  };

  router.get(
    "/bots/:id/try",
    wrap(async (req, res) => {
      const { actor, csrf } = adminOf(res);
      if (!isAdmin(actor)) return page(res, 403, "Not allowed.");
      const { def, everyone, person, may } = await load(res, req.params.id, typeof req.query.as === "string" ? req.query.as : "");
      const prompt = typeof req.query.prompt === "string" ? req.query.prompt.slice(0, MAX_TEXT) : "";
      const chatId = tryChatId(def.id, person.id);
      const earlier = await db
        .select({ summary: auditEvents.summary, startedAt: auditEvents.startedAt, status: auditEvents.status })
        .from(auditEvents)
        .where(and(eq(auditEvents.chatId, chatId), eq(auditEvents.kind, "message")))
        .orderBy(desc(auditEvents.startedAt))
        .limit(10);
      const when = await whenFor(db, actor.tenantId);
      const name = def.displayName ?? def.name;
      const body = html`<header class="be-pagehead"><div class="pt"><nav class="crumb" aria-label="breadcrumb"><a href="/admin/bots">bots</a> / <a href="/admin/bots/${def.id}">${name}</a> / <span aria-current="page">try it</span></nav><h1>Try ${name}</h1><p class="meta">Talk to it here as any person. It answers with that person's rights and departments, and remembers this test chat only.</p></div></header>
<form class="be-form try-as" method="get" action="/admin/bots/${def.id}/try" data-autosave><input type="hidden" name="prompt" value="${prompt}"><div class="fields"><label>as <select class="be-select" name="as">${everyone.map((p) => html`<option value="${p.id}" ${p.id === person.id ? "selected" : ""}>${p.name} · ${roleWords(p)}</option>`)}</select> <button class="be-btn sm auto">change</button></label></div></form>
${
  !may
    ? html`<div class="be-notice"><span>${person.name} can't talk to ${name}: not in a department this bot is allowed for.</span></div>`
    : !deps.runTurn
      ? html`<div class="be-notice"><span>The engine isn't connected to the admin site.</span></div>`
      : html`${def.identity === "person" ? html`<p class="be-muted">Microsoft 365 isn't available in a test chat; try that in Teams.</p>` : ""}${
          earlier.length
            ? html`<section class="try-earlier"><h2>earlier replies to ${person.name}</h2>${earlier.reverse().map((e) => html`<p><span class="be-muted">${when(e.startedAt)}</span> ${e.summary}${e.status !== "done" ? html` <span class="be-chip b">${e.status}</span>` : ""}</p>`)}<form method="post" action="/admin/bots/${def.id}/try/reset"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="as" value="${person.id}"><button class="be-btn sm">forget this chat</button></form></section>`
            : ""
        }<form class="be-form try-send" method="post" action="/admin/bots/${def.id}/try"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="as" value="${person.id}"><div class="fields"><label>message <textarea class="be-input" name="text" rows="4" required maxlength="${MAX_TEXT}" placeholder="what ${person.name} would type in Teams">${prompt}</textarea></label></div><button class="be-btn primary">send</button></form>`
}`;
      res.type("html").send(layout({ title: `Try ${name}`, body, actor, csrf }));
    }),
  );

  router.post(
    "/bots/:id/try",
    wrap(async (req, res) => {
      const { actor, csrf } = adminOf(res);
      if (!isAdmin(actor)) return page(res, 403, "Not allowed.");
      const { def, person, may } = await load(res, req.params.id, field(req, "as"));
      const text = field(req, "text").trim().slice(0, MAX_TEXT);
      if (!may || !deps.runTurn || !text) return res.redirect(303, `/admin/bots/${def.id}/try?as=${person.id}`);
      const chatId = tryChatId(def.id, person.id);
      await upsertChat(db, { id: chatId, tenantId: actor.tenantId, conversationType: "test", name: `Test: ${def.displayName ?? def.name} as ${person.name}` });
      await recordChatOwner(db, chatId, person.id);
      const [row] = await db.select().from(people).where(eq(people.id, person.id));
      const name = def.displayName ?? def.name;
      const back = `/admin/bots/${def.id}/try?as=${person.id}`;
      // the page goes out in two halves: the reply streams in between them as the bot writes it
      const [head, tail] = layout({
        title: `Try ${name}`,
        actor,
        csrf,
        body: html`<header class="be-pagehead"><div class="pt"><nav class="crumb" aria-label="breadcrumb"><a href="/admin/bots">bots</a> / <a href="/admin/bots/${def.id}">${name}</a> / <a href="${back}">try it</a></nav><h1>${person.name} → ${name}</h1></div></header><div class="be-card try"><p class="you">${text}</p><div class="bot">${raw(MARK)}</div></div><p><a class="be-btn" href="${back}">ask more</a></p>`,
      }).split(MARK) as [string, string];
      res.type("html");
      res.write(head);
      let soFar = "";
      const write = (s: string) => res.write(s);
      const progress = (e: ProgressEvent) => {
        if (e.kind === "delta") {
          soFar += e.text;
          write(html`${e.text}`.value);
        } else if (e.kind === "tool") write(html`<span class="step">· ${toolLabel(e.toolName)}</span>`.value);
        else if (e.kind === "text") write(html`<span class="step">${e.text}</span>`.value);
      };
      try {
        const result = await deps.runTurn({
          tenantId: actor.tenantId,
          chatId,
          definition: def,
          person: row,
          text,
          progress,
          askConfirmation: async (c) => {
            // the admin answers for the person, on this page (the script sends the click while the reply still streams);
            // without script the answer opens in a new tab
            write(
              html`<form class="confirm" id="c-${c.actionId}" method="post" action="/admin/bots/${def.id}/try/confirm" target="_blank"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="as" value="${person.id}"><input type="hidden" name="actionId" value="${c.actionId}"><b>${c.name ?? c.label} wants to ${toolLabel(c.toolName, c.input)}.</b> <span class="be-muted">${Object.entries(c.input).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · ").slice(0, 400)}</span> <button class="be-btn primary sm" name="answer" value="yes">yes</button> <button class="be-btn sm" name="answer" value="no">no</button></form>${raw(CONFIRM_SCRIPT(c.actionId))}`.value,
            );
          },
        });
        const reply = result.text.trim();
        if (!soFar.trimEnd().endsWith(reply)) write(html`${soFar ? "\n\n" : ""}${reply}`.value);
        write(html`<p class="be-muted meta">$${result.costUsd.toFixed(4)}${result.timings.tools ? ` · ${result.timings.tools} tools` : ""}</p>`.value);
      } catch (err) {
        console.error(err);
        write(html`<p class="be-chip b">Something went wrong on my side.</p>`.value);
      }
      res.end(tail);
    }),
  );

  // one answer per confirmation; the click arrives from the streaming page (fetch) or a new tab (no script)
  router.post(
    "/bots/:id/try/confirm",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return page(res, 403, "Not allowed.");
      const { person } = await load(res, req.params.id, field(req, "as"));
      const answer = field(req, "answer") === "yes" ? "yes" : "no";
      const outcome = (await deps.confirmations?.resolve(field(req, "actionId"), person.id, answer)) ?? "unknown";
      res.type("text").send(outcome);
    }),
  );

  router.post(
    "/bots/:id/try/reset",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return page(res, 403, "Not allowed.");
      const { def, person } = await load(res, req.params.id, field(req, "as"));
      await db.delete(sessions).where(eq(sessions.chatId, tryChatId(def.id, person.id)));
      res.redirect(303, `/admin/bots/${def.id}/try?as=${person.id}`);
    }),
  );

  return router;
}
