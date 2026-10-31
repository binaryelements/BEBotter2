import express from "express";
import type { Request, Response, Router } from "express";
import {
  addMcpServer, allowedDepartments, botDefinitionInput, getDefinition, listDefinitions, removeMcpServer, setAllowedDepartments, setPersona,
  updateDefinitionFields, upsertDefinition,
} from "../bots/definitions.js";
import { count, eq } from "drizzle-orm";
import { activeMcp, listConnections, listConnectionsFor, mcpReadOnly, resetHostKey, revokeConnection, setLinked } from "../connections/store.js";
import type { Db } from "../db/client.js";
import type { BotDefinition, Connection } from "../db/schema.js";
import { defaultClass } from "../engine/gate.js";
import type { ToolRule } from "../engine/gate.js";
import { knownTools, setToolRule, toolRulesFor, toolSource } from "../engine/tool-rules.js";
import { beginAction, completeAction } from "../audit/audit.js";
import { chatAssignments, chats, mailboxes, people } from "../db/schema.js";
import { MailError } from "../mail/agentmail.js";
import { ensureMailbox, MailboxError, removeMailbox, requestMailbox, restoreMailbox } from "../mail/mailboxes.js";
import type { MailDeps } from "../mail/mailboxes.js";
import { DirectoryError, listDepartments } from "../org/directory.js";
import { getTenantSettings } from "../org/org.js";
import { createRoutine, deleteRoutine, listRoutines, updateRoutine } from "../routines/store.js";
import { isAdmin, mayEditPersona } from "./access.js";
import { html, layout, raw } from "./html.js";
import type { SafeHtml } from "./html.js";
import { adminOf, wrap } from "./http.js";
import { page } from "./oidc.js";
import { armedPage } from "./arm.js";
import { botsTable, visibleBots } from "./overview.js";

const field = (req: Request, name: string) => {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof v === "string" ? v : "";
};
const many = (req: Request, name: string) => {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string");
};
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const deny = (res: Response) => page(res, 403, "Not allowed.");

export function botRoutes(deps: { db: Db; secretsKey: Buffer; defaultModel: string; onSaved?: (definitionId: string) => void; mail?: MailDeps }): Router {
  const { db, secretsKey, defaultModel, onSaved, mail } = deps;
  const router = express.Router();
  const render = (res: Response, title: string, body: SafeHtml) => {
    const { actor, csrf } = adminOf(res);
    res.type("html").send(layout({ title, body, actor, csrf }));
  };
  const TABS = ["overview", "persona", "email", "actions", "connections", "routines", "chats"] as const;
  type Tab = (typeof TABS)[number];
  const csrfField = (res: Response, tab?: Tab) => html`<input type="hidden" name="csrf" value="${adminOf(res).csrf}">${tab ? html`<input type="hidden" name="tab" value="${tab}">` : ""}`;
  // actions return to the tab they were made on
  const back = (req: Request, id: string) => `/admin/bots/${id}${(TABS as readonly string[]).includes(field(req, "tab")) ? `?tab=${field(req, "tab")}` : ""}`;
  const armed = (res: Response, req: Request, title: string, what: string, backHref: string) => armedPage(req, res, { title, button: what, back: backHref });
  const yesNo = (b: boolean) => (b ? "Yes" : "No");
  const mailDomain = async () => {
    try {
      return mail ? await mail.admin.mailDomain() : undefined;
    } catch {
      return undefined; // BE AgentMail unreachable: the field is simply not offered
    }
  };
  const mailboxOf = async (id: string) => (await db.select().from(mailboxes).where(eq(mailboxes.definitionId, id)))[0];
  // the definition must belong to the admin's tenant: the mailbox functions take only an id
  const ownBot = async (tenantId: string, id: string) => {
    const def = await getDefinition(db, tenantId, id);
    if (!def) throw new DirectoryError("Bot not found");
    return def;
  };
  // one audit row per action, with its outcome; a failed write never fails the action
  const audit = async (actor: { tenantId: string; personId: string }, what: string, definitionId: string, outcome: "done" | "failed", note = "") => {
    try {
      const rowId = await beginAction(db, { tenantId: actor.tenantId, definitionId, personId: actor.personId, kind: "admin", toolName: what, summary: `Admin: ${what}${note ? ` (${note})` : ""}`.slice(0, 300) });
      await completeAction(db, rowId, { status: outcome });
    } catch (e) {
      console.error("admin audit:", e instanceof Error ? e.name : "error");
    }
  };
  const mailMessage = (e: unknown): string | undefined => {
    if (e instanceof MailboxError) return e.reason === "taken" ? "That address is taken" : e.reason === "removed" ? "This email address was removed. Restore it instead." : e.message;
    if (e instanceof MailError) return e.detail ? `BE AgentMail: ${e.detail}` : "BE AgentMail did not accept that. Try again later.";
    return undefined;
  };
  const SEND_AS_SHOWN = ["status", "state", "enabled", "active", "message", "detail", "reason"];
  // free-form answer from BE AgentMail, shown as plain fields; nothing that looks like a key
  const plainFields = (r: Record<string, unknown>) =>
    Object.entries(r).filter(([k, v]) => SEND_AS_SHOWN.includes(k) && ["string", "boolean"].includes(typeof v) && !/\b(bam_|amwh_)/.test(String(v))).map(([k, v]) => `${k}: ${v}`).join("; ");

  router.get(
    "/bots",
    wrap(async (_req, res) => {
      const { actor } = adminOf(res);
      const admin = isAdmin(actor);
      const [{ defs }, settings, domain] = await Promise.all([visibleBots(db, actor), getTenantSettings(db, actor.tenantId), admin ? mailDomain() : undefined]);
      render(
        res,
        "Bots",
        html`<header class="be-pagehead"><div class="pt"><h1>Bots</h1></div></header>
${await botsTable(db, actor.tenantId, defs)}${
          admin
            ? html`<details class="be-section"><summary class="be-btn">add bot…</summary><h2>New bot</h2><form method="post" action="/admin/bots">${csrfField(res)}
<p><label>Name <input name="displayName" maxlength="60"></label> <label>Handle <input name="name" required></label> <label>Label <input name="label" required></label> <label>Model <input name="model" value="${settings.defaultModel ?? defaultModel}"></label></p>
${domain ? html`<p><label>Email address <input name="localPart" maxlength="36" autocomplete="off"></label> @${domain}</p>` : ""}
<p><label>Persona<textarea name="persona"></textarea></label></p><button class="be-btn primary">Create</button></form></details>`
            : ""
        }`,
      );
    }),
  );

  router.post(
    "/bots",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      const parsed = botDefinitionInput.safeParse({
        name: field(req, "name").trim(), displayName: "displayName" in ((req.body as object) ?? {}) ? field(req, "displayName") : undefined, label: field(req, "label").trim(), persona: field(req, "persona"), model: field(req, "model").trim() || undefined,
      });
      if (!parsed.success) throw new DirectoryError(parsed.error.issues[0].message);
      if ((await listDefinitions(db, actor.tenantId)).some((d) => d.name === parsed.data.name)) throw new DirectoryError(`Bot "${parsed.data.name}" already exists`);
      const def = await upsertDefinition(db, secretsKey, actor.tenantId, parsed.data);
      onSaved?.(def.id);
      const localPart = field(req, "localPart").trim();
      if (mail && localPart) {
        try {
          const address = await requestMailbox(mail, def.id, localPart); // bounded wait; the bot page shows the address or that it is being created
          await audit(actor, "mailbox", def.id, address ? "done" : "failed", address ? "" : "still being created");
        } catch (e) {
          const msg = mailMessage(e) ?? "Something went wrong.";
          if (!mailMessage(e)) console.error("mailbox:", e instanceof Error ? e.name : "error");
          await audit(actor, "mailbox", def.id, "failed", msg);
          return render(res, "Bot created", html`<h1>Bot created</h1><p>${msg}.</p><p><a href="/admin/bots/${def.id}">Open the bot</a></p>`);
        }
      }
      res.redirect(303, back(req, def.id));
    }),
  );

  const mailSectionFor = async (res: Response, id: string): Promise<SafeHtml> => {
    if (!mail) return html`<div class="be-empty">Email is not set up.</div>`;
    const csrf = csrfField(res, "email");
    const box = await mailboxOf(id);
    const act = (path: string, label: string, extra: SafeHtml = html``) => html`<form method="post" action="/admin/bots/${id}/${path}">${csrf}${extra}<button class="be-btn">${label}</button></form>`;
    if (!box) {
      const domain = await mailDomain();
      return html`<h2>Email</h2><form method="post" action="/admin/bots/${id}/mailbox">${csrf}<p><label>Email address <input name="localPart" maxlength="36" autocomplete="off" required></label>${domain ? html` @${domain}` : ""}</p><button class="be-btn primary">Create email address</button></form>`;
    }
    const label = box.status === "active" ? "Active" : box.status === "pending" ? "Being created" : box.status === "removing" ? "Being removed" : "Removed";
    let sendAs: SafeHtml = html``;
    if (box.status === "active" && box.inboxId) {
      let state = "";
      try {
        state = plainFields(await mail.admin.getSendAs(box.inboxId));
      } catch {
        state = "unknown";
      }
      sendAs = html`<h3>Company address</h3>${state ? html`<p>${state}</p>` : ""}
<form method="post" action="/admin/bots/${id}/send-as">${csrf}<p><label>Company address <input type="email" name="address" placeholder="name@example.com" required></label></p><button class="be-btn">Save</button></form>${act("send-as/remove", "Clear")}
<p>In Microsoft 365, forward the company address to ${box.address ?? ""} with a plain forward, and allow automatic forwarding in the outbound anti-spam policy.</p>`;
    }
    return html`<h2>Email</h2><dl class="be-kv"><div><dt>address</dt><dd>${box.address ?? box.localPart ?? ""}</dd></div><div><dt>status</dt><dd>${label}</dd></div></dl>${
      box.status === "active" ? act("mailbox/remove", "Remove email address") : box.status === "removed" ? act("mailbox/restore", "Restore email address")
        : box.status === "pending" ? act("mailbox/retry", "Try again") : box.status === "removing" ? act("mailbox/remove", "Finish removing") : ""
    }${sendAs}`;
  };

  const RULE_LABEL: Record<ToolRule, string> = { free: "Runs freely", confirm: "Needs confirmation" };
  // every tool the engine announced for the bot, with its default and the admin's rule; approve-class is locked
  const actionsOf = async (def: BotDefinition, linked: Connection[]) => {
    const [tools, rules] = await Promise.all([knownTools(db, def.id), toolRulesFor(db, def.id)]);
    const readOnly = mcpReadOnly(activeMcp(linked));
    return tools.map((tool) => {
      const base = defaultClass(tool, def, readOnly);
      const fallback: ToolRule = base === "read" ? "free" : "confirm";
      const current: ToolRule = base === "approve" ? "confirm" : (rules.get(tool) ?? fallback);
      return { tool, locked: base === "approve", fallback, current };
    });
  };
  const actionsSectionFor = async (res: Response, def: BotDefinition, linked: Connection[]): Promise<SafeHtml> => {
    const actions = await actionsOf(def, linked);
    if (!actions.length) return html`<div class="be-empty">Nothing yet. Actions appear once the bot has started.</div>`;
    const groups = new Map<string, typeof actions>();
    for (const a of actions) groups.set(toolSource(a.tool), [...(groups.get(toolSource(a.tool)) ?? []), a]);
    const row = (a: (typeof actions)[number]) => html`<tr><td>${a.tool.replace(/^mcp__.+?__/, "")}</td><td>${
      a.locked
        ? html`${RULE_LABEL.confirm} (locked)`
        : html`<div class="be-seg" role="radiogroup" aria-label="${a.tool}">${(["free", "confirm"] as const).map(
            (r) => html`<label><input type="radio" name="rule:${a.tool}" value="${r}" ${a.current === r ? "checked" : ""}><span>${RULE_LABEL[r]}${a.fallback === r ? " (default)" : ""}</span></label>`,
          )}</div>`
    }</td></tr>`;
    return html`<h2>Actions</h2><form method="post" action="/admin/bots/${def.id}/actions">${csrfField(res, "actions")}${[...groups.keys()].sort().map(
      (g) => html`<h3>${g}</h3><table class="be-table"><tbody>${groups.get(g)!.map(row)}</tbody></table>`,
    )}<p><button class="be-btn primary">Save</button></p></form>`;
  };

  router.get(
    "/bots/:id",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!(await mayEditPersona(db, actor, req.params.id))) return deny(res);
      const def = (await getDefinition(db, actor.tenantId, req.params.id))!;
      const admin = isAdmin(actor);
      const mb = await mailboxOf(def.id);
      const [chatCount] = await db.select({ n: count() }).from(chatAssignments).where(eq(chatAssignments.definitionId, def.id));
      const head = (tab?: Tab) => html`<header class="be-pagehead"><div class="pt"><nav class="crumb" aria-label="breadcrumb"><a href="/admin/bots">bots</a> / <span aria-current="page">${def.displayName ?? def.name}</span></nav><h1>${def.displayName ?? def.name} · ${def.label}</h1><p class="meta">${mb?.address ? `${mb.address} · ` : ""}${def.model} · ${chatCount.n} chats</p></div></header>${
        tab ? html`<nav class="be-tabs" aria-label="bot">${TABS.map((t) => html`<a href="/admin/bots/${def.id}?tab=${t}"${t === tab ? raw(' class="active" aria-current="page"') : ""}>${t}</a>`)}</nav>` : ""
      }`;
      const personaBox = html`<p><label>Persona<textarea name="persona">${def.persona}</textarea></label></p>`;
      let body: SafeHtml;
      if (!admin) {
        body = html`${head()}<form method="post" action="/admin/bots/${def.id}">${csrfField(res)}${personaBox}<button class="be-btn primary">Save</button></form>`;
      } else {
        const asked = typeof req.query.tab === "string" ? req.query.tab : "";
        const tab = TABS.find((t) => t === asked) ?? "overview";
        const csrf = csrfField(res, tab);
        const [depts, allowed, conns, linked, rts, assigned, ppl] = await Promise.all([
          listDepartments(db, actor.tenantId), allowedDepartments(db, def.id), listConnections(db, actor.tenantId), listConnectionsFor(db, actor.tenantId, def.id),
          listRoutines(db, actor.tenantId, def.id),
          db.select({ id: chats.id, label: chats.label }).from(chatAssignments).innerJoin(chats, eq(chats.id, chatAssignments.chatId))
            .where(eq(chatAssignments.definitionId, def.id)),
          db.select({ id: people.id, name: people.name }).from(people).where(eq(people.tenantId, actor.tenantId)),
        ]);
        const linkedIds = new Set(linked.map((c) => c.id));
        const chatLabel = new Map(assigned.map((c) => [c.id, c.label ?? c.id.slice(-12)]));
        const personName = new Map(ppl.map((p) => [p.id, p.name]));
        // one endpoint saves the whole definition, so each of the two forms carries the other's fields unchanged
        const hide = (name: string, value: string) => html`<input type="hidden" name="${name}" value="${value}">`;
        const settings = (on: "overview" | "persona") => html`<form method="post" action="/admin/bots/${def.id}">${csrf}${
          on === "overview"
            ? html`<p><label>Name <input name="displayName" value="${def.displayName ?? ""}" maxlength="60"></label> <label>Label <input name="label" value="${def.label}" required></label> <label>Model <input name="model" value="${def.model}" required></label></p>
<p><label><input type="checkbox" name="webSearch" ${def.webSearch ? "checked" : ""}> Web search</label> <label><input type="checkbox" name="computer" ${def.computer ? "checked" : ""}> Computer</label></p>
<fieldset><legend>Departments</legend>${depts.map((d) => html`<label><input type="checkbox" name="departments" value="${d.id}" ${allowed.includes(d.id) ? "checked" : ""}> ${d.name}</label> `)}</fieldset>${hide("persona", def.persona)}`
            : html`${personaBox}${hide("displayName", def.displayName ?? "")}${hide("label", def.label)}${hide("model", def.model)}${def.webSearch ? hide("webSearch", "on") : ""}${def.computer ? hide("computer", "on") : ""}${allowed.map((d) => hide("departments", d))}`
        }<p><button class="be-btn primary">Save</button></p></form>`;
        let section: SafeHtml;
        if (tab === "overview") {
          section = html`<dl class="be-kv"><div><dt>model</dt><dd>${def.model}</dd></div><div><dt>web search</dt><dd>${yesNo(def.webSearch)}</dd></div><div><dt>computer</dt><dd>${yesNo(def.computer)}</dd></div><div><dt>departments</dt><dd>${depts.filter((d) => allowed.includes(d.id)).map((d) => d.name).join(", ") || "none"}</dd></div></dl>${settings("overview")}`;
        } else if (tab === "persona") {
          section = settings("persona");
        } else if (tab === "email") {
          section = await mailSectionFor(res, def.id);
        } else if (tab === "actions") {
          section = await actionsSectionFor(res, def, linked);
        } else if (tab === "connections") {
          const connRows = conns.map((c) => html`<tr><td>${c.name}</td><td>${c.kind}</td><td>${c.target}</td><td>${c.mode}</td><td>${c.status}</td><td>${c.secretCipher ? "set" : "none"}</td>
<td><form method="post" action="/admin/bots/${def.id}/connections/${c.id}/link">${csrf}<input type="hidden" name="linked" value="${linkedIds.has(c.id) ? "off" : "on"}"><button class="be-btn sm">${linkedIds.has(c.id) ? "Unlink" : "Link"}</button></form></td>
<td>${c.status === "revoked" ? "" : html`<form method="post" action="/admin/connections/${c.id}/revoke">${csrf}<button class="be-btn sm danger">Revoke</button></form>`}${
            c.status === "blocked" ? html`<form method="post" action="/admin/connections/${c.id}/reset-host-key">${csrf}<button class="be-btn sm">Reset host key</button></form>` : ""}</td></tr>`);
          section = html`<h2>MCP servers</h2>
<table class="be-table"><thead><tr><th>Name</th><th>Transport</th><th>Read-only tools</th><th>Headers</th><th></th></tr></thead><tbody>${def.mcpServers.map(
            (s) => html`<tr><td>${s.name}</td><td>${s.transport}</td><td>${s.readOnlyTools.join(", ")}</td><td>${s.headersCipher ? "headers set" : "none"}</td><td><form method="post" action="/admin/bots/${def.id}/servers/${encodeURIComponent(s.name)}/delete">${csrf}<button class="be-btn sm">Remove</button></form></td></tr>`,
          )}</tbody></table>
<form method="post" action="/admin/bots/${def.id}/servers">${csrf}
<p><label>Name <input name="name" required></label> <label>Transport <select name="transport"><option>http</option><option>stdio</option></select></label> <label>URL <input name="url"></label> <label>Command <input name="command"></label> <label>Args <input name="args"></label></p>
<p><label>Header name <input name="headerName"></label> <label>Header value <input type="password" name="headerValue" autocomplete="off"></label> <label>Read-only tools <input name="readOnlyTools"></label></p>
<button class="be-btn">Add server</button></form>
<h2>Connections</h2>
<table class="be-table"><thead><tr><th>Name</th><th>Kind</th><th>Target</th><th>Mode</th><th>Status</th><th>Secret</th><th>This bot</th><th></th></tr></thead><tbody>${connRows}</tbody></table>`;
        } else if (tab === "routines") {
          const routineRows = rts.map((r) => html`<tr><td>${r.prompt.slice(0, 80)}</td><td>${r.schedule ?? r.runAt?.toISOString() ?? ""}</td><td>${chatLabel.get(r.chatId) ?? r.chatId.slice(-12)}</td><td>${yesNo(r.quiet)}</td><td>${yesNo(r.enabled)}</td><td>${r.grantPersonId ? (personName.get(r.grantPersonId) ?? "—") : "—"}</td>
<td><form method="post" action="/admin/bots/${def.id}/routines/${r.id}/enabled">${csrf}<input type="hidden" name="enabled" value="${r.enabled ? "off" : "on"}"><button class="be-btn sm">${r.enabled ? "Disable" : "Enable"}</button></form>
<form method="post" action="/admin/bots/${def.id}/routines/${r.id}/delete">${csrf}<button class="be-btn sm">Delete</button></form></td></tr>`);
          section = html`<h2>Routines</h2>
<table class="be-table"><thead><tr><th>Prompt</th><th>When</th><th>Chat</th><th>Quiet</th><th>Enabled</th><th>Grant</th><th></th></tr></thead><tbody>${routineRows}</tbody></table>
<form method="post" action="/admin/bots/${def.id}/routines">${csrf}
<p><label>Chat <select name="chatId">${assigned.map((c) => html`<option value="${c.id}">${chatLabel.get(c.id)}</option>`)}</select></label> <label>Schedule <input name="schedule" placeholder="0 9 * * 1-5" required></label> <label><input type="checkbox" name="quiet"> Quiet</label> <label><input type="checkbox" name="grant"> Grant my access</label></p>
<p><label>Prompt<textarea name="prompt" required></textarea></label></p><button class="be-btn">Add routine</button></form>`;
        } else {
          section = assigned.length ? html`<ul>${assigned.map((c) => html`<li>${chatLabel.get(c.id)}</li>`)}</ul>` : html`<div class="be-empty">No chats yet.</div>`;
        }
        body = html`${head(tab)}<div class="be-section">${section}</div>`;
      }
      render(res, def.label, body);
    }),
  );

  router.post(
    "/bots/:id",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      const id = req.params.id;
      if (!(await mayEditPersona(db, actor, id))) return deny(res);
      if (!isAdmin(actor)) {
        await setPersona(db, actor.tenantId, id, field(req, "persona"));
      } else {
        await updateDefinitionFields(db, actor.tenantId, id, {
          displayName: "displayName" in ((req.body as object) ?? {}) ? field(req, "displayName") : undefined, label: field(req, "label").trim(), persona: field(req, "persona"), model: field(req, "model").trim(),
          webSearch: field(req, "webSearch") === "on", computer: field(req, "computer") === "on",
        });
        await setAllowedDepartments(db, actor.tenantId, id, many(req, "departments"));
        onSaved?.(id);
      }
      res.redirect(303, back(req, id));
    }),
  );

  // Mailbox actions: admins only, and only for a bot of the admin's own tenant.
  const mailAction = (path: string, run: (req: Request, id: string, tenantId: string) => Promise<void>) =>
    router.post(
      `/bots/:id/${path}`,
      wrap(async (req, res) => {
        const { actor } = adminOf(res);
        if (!isAdmin(actor)) return deny(res);
        if (!mail) throw new DirectoryError("Email is not set up");
        await ownBot(actor.tenantId, req.params.id);
        if (path === "mailbox/remove" && field(req, "confirm") !== "yes") return armed(res, req, "Remove email address?", "confirm remove?", back(req, req.params.id));
        try {
          await run(req, req.params.id, actor.tenantId);
        } catch (e) {
          const msg = mailMessage(e) ?? (e instanceof DirectoryError ? e.message : undefined);
          await audit(actor, path, req.params.id, "failed", msg);
          if (!msg) throw e;
          throw new DirectoryError(msg);
        }
        await audit(actor, path, req.params.id, "done");
        res.redirect(303, back(req, req.params.id));
      }),
    );
  mailAction("mailbox", async (req, id) => void (await requestMailbox(mail!, id, field(req, "localPart"))));
  mailAction("mailbox/remove", (_req, id) => removeMailbox(mail!, id));
  mailAction("mailbox/retry", async (_req, id) => void (await ensureMailbox(mail!, id)));
  mailAction("mailbox/restore", async (_req, id) => void (await restoreMailbox(mail!, id)));
  const activeInbox = async (id: string) => {
    const box = await mailboxOf(id);
    if (box?.status !== "active" || !box.inboxId) throw new DirectoryError("This bot has no active email address");
    return box.inboxId;
  };
  mailAction("send-as", async (req, id) => {
    const address = field(req, "address").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new DirectoryError("Enter an email address");
    const inbox = await activeInbox(id);
    const verdict = await mail!.admin.checkSendAs(address);
    if (!verdict.ok) throw new DirectoryError(verdict.reasons.length ? `Cannot send as that address: ${verdict.reasons.join("; ")}` : "Cannot send as that address");
    await mail!.admin.requestSendAs(inbox, address);
  });
  mailAction("send-as/remove", async (_req, id) => mail!.admin.removeSendAs(await activeInbox(id)));

  router.post(
    "/bots/:id/actions",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      const def = await ownBot(actor.tenantId, req.params.id);
      const actions = await actionsOf(def, await listConnectionsFor(db, actor.tenantId, def.id));
      // only tools the bot has are read from the form; all are checked before any is saved
      const changes: ((typeof actions)[number] & { want: ToolRule })[] = [];
      for (const a of actions) {
        const want = field(req, `rule:${a.tool}`);
        if (want !== "free" && want !== "confirm") continue;
        if (a.locked && want === "free") throw new DirectoryError(`${a.tool} always needs confirmation`);
        if (want !== a.current) changes.push({ ...a, want });
      }
      for (const c of changes) {
        await setToolRule(db, def.id, c.tool, c.want === c.fallback ? undefined : c.want);
        await audit(actor, c.tool, def.id, "done", `${RULE_LABEL[c.current]} → ${RULE_LABEL[c.want]}`);
      }
      res.redirect(303, back(req, def.id));
    }),
  );

  router.post(
    "/bots/:id/servers",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      const headerName = field(req, "headerName").trim();
      const headerValue = field(req, "headerValue");
      if (!headerName !== !headerValue) throw new DirectoryError("Header name and value go together");
      if (headerName && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName)) throw new DirectoryError("Invalid header name");
      if (headerValue && (/[\r\n\0]/.test(headerValue) || !headerValue.trim())) throw new DirectoryError("Invalid header value");
      const transport = field(req, "transport");
      await addMcpServer(db, secretsKey, actor.tenantId, req.params.id, {
        name: field(req, "name").trim(),
        transport: transport as "http" | "stdio", // zod rejects anything else
        url: field(req, "url").trim() || undefined,
        command: field(req, "command").trim() || undefined,
        args: list(field(req, "args")),
        headers: headerName ? { [headerName]: headerValue } : undefined,
        readOnlyTools: list(field(req, "readOnlyTools")),
      });
      res.redirect(303, back(req, req.params.id));
    }),
  );

  router.post(
    "/bots/:id/servers/:name/delete",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      await removeMcpServer(db, actor.tenantId, req.params.id, req.params.name);
      res.redirect(303, back(req, req.params.id));
    }),
  );

  router.post(
    "/bots/:id/connections/:connectionId/link",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      await setLinked(db, actor.tenantId, req.params.id, req.params.connectionId, field(req, "linked") === "on");
      res.redirect(303, back(req, req.params.id));
    }),
  );

  router.post(
    "/connections/:connectionId/revoke",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      if (field(req, "confirm") !== "yes") return armed(res, req, "Revoke connection?", "confirm revoke?", "/admin/bots");
      const c = await revokeConnection(db, actor.tenantId, req.params.connectionId);
      render(res, "Revoked", html`<h1>Revoked ${c.name}</h1>${
        c.kind === "ssh" && c.publicKey
          ? html`<p>Remove this line from the target's authorized_keys:</p><pre>${c.publicKey}</pre>`
          : html`<p>Revoke the token at its source.</p>`
      }<p><a href="/admin/bots">Back</a></p>`);
    }),
  );

  router.post(
    "/connections/:connectionId/reset-host-key",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      await resetHostKey(db, actor.tenantId, req.params.connectionId);
      res.redirect(303, "/admin/bots");
    }),
  );

  router.post(
    "/bots/:id/routines",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      await createRoutine(db, actor.tenantId, {
        definitionId: req.params.id, chatId: field(req, "chatId"), prompt: field(req, "prompt").trim(), schedule: field(req, "schedule").trim(),
        quiet: field(req, "quiet") === "on", grantPersonId: field(req, "grant") === "on" ? actor.personId : null, createdByPersonId: actor.personId,
      });
      res.redirect(303, back(req, req.params.id));
    }),
  );

  // a routine id from another bot is refused, not edited
  const ownRoutine = async (tenantId: string, botId: string, id: string) => {
    if (!(await listRoutines(db, tenantId, botId)).some((r) => r.id === id)) throw new DirectoryError("No such routine");
  };

  router.post(
    "/bots/:id/routines/:rid/enabled",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      await ownRoutine(actor.tenantId, req.params.id, req.params.rid);
      await updateRoutine(db, actor.tenantId, req.params.rid, { enabled: field(req, "enabled") === "on" });
      res.redirect(303, back(req, req.params.id));
    }),
  );

  router.post(
    "/bots/:id/routines/:rid/delete",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      await ownRoutine(actor.tenantId, req.params.id, req.params.rid);
      await deleteRoutine(db, actor.tenantId, req.params.rid);
      res.redirect(303, back(req, req.params.id));
    }),
  );

  return router;
}
