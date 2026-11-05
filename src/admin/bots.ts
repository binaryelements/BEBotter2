import { parseMcpAdd } from "../bots/mcp-command.js";
import { PERSONA_TEMPLATES, personaTemplate } from "../bots/templates.js";
import express from "express";
import type { Request, Response, Router } from "express";
import {
  addMcpServer, allowedDepartments, botDefinitionInput, getDefinition, listDefinitions, removeMcpServer, setAllowedDepartments, setGraph, setPersona,
  updateDefinitionFields, upsertDefinition,
} from "../bots/definitions.js";
import { and, count, eq } from "drizzle-orm";
import { listMcpToolInfo } from "../connections/http.js";
import { accessToken, beginSignIn, discover, finishSignIn, oauthOf, OAuthError } from "../connections/oauth.js";
import { activeMcp, adminVerify, ConnectionError, createConnection, listConnections, listConnectionsFor, mcpReadOnly, resetHostKey, revokeConnection, setLinked } from "../connections/store.js";
import type { ConnectionKind, ConnectionMode } from "../connections/store.js";
import { SQL_ENGINES } from "../connections/sql.js";
import type { SqlRunner } from "../connections/sql.js";
import { systemSsh } from "../connections/ssh.js";
import type { SshRunner } from "../connections/ssh.js";
import type { Db } from "../db/client.js";
import type { BotDefinition, Connection } from "../db/schema.js";
import { defaultClass } from "../engine/gate.js";
import type { ToolRule } from "../engine/gate.js";
import { knownTools, recordTools, setToolRule, toolRulesFor, toolSource } from "../engine/tool-rules.js";
import { decrypt } from "../secrets/cipher.js";
import { beginAction, completeAction } from "../audit/audit.js";
import { GRAPH_CAPABILITIES, botDefinitions, chatAssignments, chats, connections, definitionConnections, mailboxes, people } from "../db/schema.js";
import { MailError } from "../mail/agentmail.js";
import { ensureMailbox, MailboxError, removeMailbox, requestMailbox, restoreMailbox } from "../mail/mailboxes.js";
import type { MailDeps } from "../mail/mailboxes.js";
import { DirectoryError, listDepartments } from "../org/directory.js";
import { getTenantSettings } from "../org/org.js";
import { createRoutine, deleteRoutine, listRoutines, updateRoutine } from "../routines/store.js";
import { addLearning, deleteLearning, listLearnings, updateLearning } from "../learnings/store.js";
import { isAdmin, mayEditPersona, mayEnter } from "./access.js";
import { AUTO, html, layout, raw, scroll } from "./html.js";
import type { SafeHtml } from "./html.js";
import { adminOf, wrap } from "./http.js";
import { page } from "./oidc.js";
import { armedPage, isArmed } from "./arm.js";
import { botsTable, visibleBots } from "./overview.js";
import { chatNames } from "./chat-names.js";
import { capabilityWords, chatTypeWords, cronWords, whenFor, whenIn } from "./words.js";
import { toolWords } from "../teams/cards.js";

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

export function botRoutes(deps: { db: Db; secretsKey: Buffer; publicUrl: string; defaultModel: string; onSaved?: (definitionId: string) => void; mail?: MailDeps; fetchFn?: typeof fetch; ssh?: SshRunner; sql?: SqlRunner }): Router {
  const { db, secretsKey, defaultModel, onSaved, mail } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const connDeps = { db, secretsKey, fetchFn, ssh: deps.ssh ?? systemSsh(), ...(deps.sql ? { sql: deps.sql } : {}) };
  const oauthRedirect = `${deps.publicUrl}/admin/connections/oauth/callback`;
  const router = express.Router();
  /** An OAuth mcp server's state after the status: signed in, or a sign-in button for an admin or department head. */
  const signInCell = (c: Connection, csrf: SafeHtml) =>
    !oauthOf(c) || c.status === "revoked" ? "" : c.status === "active" ? html` · signed in` : html` <form method="post" action="/admin/connections/${c.id}/signin">${csrf}<button class="be-btn sm primary">sign in</button></form>`;
  const render = (res: Response, title: string, body: SafeHtml) => {
    const { actor, csrf } = adminOf(res);
    res.type("html").send(layout({ title, body, actor, csrf }));
  };
  const TABS = ["overview", "persona", "email", "actions", "connections", "routines", "learnings", "chats", "m365"] as const;
  type Tab = (typeof TABS)[number];
  // Personal acts as the person: it has no mailbox or connections, and only it has Microsoft 365 capabilities
  const tabsOf = (d: BotDefinition) => TABS.filter((t) => (d.identity === "person" ? t !== "email" && t !== "connections" : t !== "m365"));
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
  // Personal acts as each person: it gets no mailbox, servers or connections of its own
  const serviceBot = async (tenantId: string, id: string) => {
    if ((await ownBot(tenantId, id)).identity === "person") throw new DirectoryError("Not available for Personal");
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
    if (e instanceof MailError) {
      console.error("mailbox:", e.message); // method, path and status; never a key or a body
      if (e.detail) return `BE AgentMail: ${e.detail}`;
      return e.status ? `BE AgentMail answered ${e.status} without saying why. Try again; if it keeps happening, check BE AgentMail.` : "BE AgentMail did not answer within 3 seconds. Try again.";
    }
    return undefined;
  };
  const SEND_AS_SHOWN = ["status", "state", "enabled", "active", "message", "detail", "reason"];
  // free-form answer from BE AgentMail, shown as plain fields; nothing that looks like a key
  const plainFields = (r: Record<string, unknown>) =>
    Object.entries(r).filter(([k, v]) => SEND_AS_SHOWN.includes(k) && ["string", "boolean"].includes(typeof v) && !/\b(bam_|amwh_)/.test(String(v))).map(([k, v]) => `${k}: ${v}`).join("; ");

  // every connection and the bots that use it, so an admin sees who can reach what in one place
  router.get(
    "/connections",
    wrap(async (_req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      const [conns, links, defs] = await Promise.all([
        listConnections(db, actor.tenantId),
        db.select({ connectionId: definitionConnections.connectionId, id: botDefinitions.id, label: botDefinitions.label, name: botDefinitions.displayName })
          .from(definitionConnections).innerJoin(botDefinitions, eq(botDefinitions.id, definitionConnections.definitionId))
          .where(eq(botDefinitions.tenantId, actor.tenantId)),
        listDefinitions(db, actor.tenantId),
      ]);
      const csrf = csrfField(res);
      const rows = conns.map((c) => {
        const bots = links.filter((l) => l.connectionId === c.id);
        return html`<tr><td>${c.name}</td><td>${c.kind}</td><td>${c.target}${c.kind === "ssh" && c.status === "pending" && c.publicKey ? html`<details><summary>public key to install</summary><pre>${c.publicKey}</pre></details>` : ""}</td><td>${c.mode}</td><td>${c.status}${signInCell(c, csrf)}</td>
<td>${bots.length ? bots.map((b, i) => html`${i ? ", " : ""}<a href="/admin/bots/${b.id}?tab=connections">${b.name ? `${b.name} · ${b.label}` : b.label}</a>`) : html`<span class="muted">no bot</span>`}</td>
<td>${c.status === "revoked" ? "" : html`<form method="post" action="/admin/connections/${c.id}/verify">${csrf}<button class="be-btn sm" title="connects once to check it works; a new ssh connection goes active">test</button></form>`}</td>
<td>${c.status === "revoked" ? "" : html`<form method="post" action="/admin/connections/${c.id}/revoke">${csrf}<button class="be-btn sm danger" title="switches it off for every bot and deletes its secret">revoke</button></form>`}</td></tr>`;
      });
      render(res, "Connections", html`<header class="be-pagehead"><div class="pt"><h1>Connections</h1></div></header>
${conns.length ? scroll(html`<table class="be-table"><thead><tr><th>Name</th><th>Kind</th><th>Target</th><th>Mode</th><th>Status</th><th>Used by</th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table>`) : html`<div class="be-empty">no connections yet: add one below, or a bot sets one up when asked in chat</div>`}
<details class="add" id="add"><summary>add a connection…</summary>
<form method="post" action="/admin/connections">${csrf}
<div class="fields">
<label>name<span class="hint">lowercase, digits and dashes</span><input name="name" required></label>
<label>kind<select name="kind"><option value="ssh">ssh</option><option value="sql">sql database</option><option value="mcp">MCP server</option><option value="http">http API</option></select></label>
<label>target<span class="hint">ssh/sql: host name; mcp/http: URL</span><input name="target" required></label>
<label>mode<select name="mode"><option value="read-only">read-only</option><option value="change">change</option></select></label>
<label>username<span class="hint">ssh and sql</span><input name="username"></label>
<label>port<span class="hint">blank for the usual one</span><input name="port" inputmode="numeric"></label>
<label>database engine<span class="hint">sql only</span><select name="engine">${SQL_ENGINES.map((e) => html`<option>${e}</option>`)}</select></label>
<label>database<span class="hint">sql only</span><input name="database"></label>
<label>header name<span class="hint">mcp/http: where the secret goes, e.g. Authorization</span><input name="headerName"></label>
<label>secret<span class="hint">sql password, or the header value (e.g. Bearer …); stored encrypted, never shown again</span><input type="password" name="secret" autocomplete="off"></label>
<label>sign in instead<span class="hint">mcp only: the server has its own login (OAuth); you sign in once after adding it, and every bot given the server shares that sign-in</span><input type="checkbox" name="oauth" value="on"></label>
</div>
<p>give to: ${defs.filter((d) => d.identity !== "person").map((d) => html`<label><input type="checkbox" name="definitionId" value="${d.id}"> ${d.displayName ? `${d.displayName} · ${d.label}` : d.label}</label> `)}</p>
<p class="muted">ssh: a key pair is made for the connection; install its public key on the target, then press test.</p>
<button class="be-btn primary">add connection</button></form></details>`);
    }),
  );

  router.post(
    "/connections",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      const kind = field(req, "kind") as ConnectionKind;
      const target = field(req, "target").trim();
      const port = field(req, "port").trim() ? Number(field(req, "port")) : undefined;
      const headerName = field(req, "headerName").trim() || undefined;
      const secret = field(req, "secret");
      let config: Record<string, unknown> = {};
      if (kind === "ssh") config = { username: field(req, "username").trim(), port: port ?? 22 };
      if (kind === "sql") config = { engine: field(req, "engine"), port, database: field(req, "database").trim(), username: field(req, "username").trim() };
      if (kind === "http") config = headerName ? { auth: { in: "header", name: headerName } } : {};
      let clientSecret: string | undefined;
      if (kind === "mcp" && field(req, "oauth") === "on") {
        // the tools are listed after the sign-in, when the server will talk to us
        const { clientSecret: cs, ...oauth } = await discover(fetchFn, target, oauthRedirect).catch((e) => { throw e instanceof OAuthError ? new DirectoryError(e.message) : e; });
        clientSecret = cs;
        config = { oauth, readOnlyTools: [] };
      } else if (kind === "mcp") {
        // the server's own read-only marks decide which tools run without a card; an unreachable server is still saved
        const tools = await listMcpToolInfo(fetchFn, { target, headers: headerName && secret ? { [headerName]: secret } : {} }).catch(() => []);
        config = { ...(headerName ? { headerName } : {}), readOnlyTools: tools.filter((t) => t.readOnly).map((t) => t.name) };
      }
      const c = await createConnection(connDeps, actor.tenantId, {
        kind, name: field(req, "name").trim(), target, mode: field(req, "mode") as ConnectionMode, config: config as never, secret, ...(clientSecret ? { clientSecret } : {}), personId: actor.personId, definitionIds: many(req, "definitionId"),
      }).catch((e) => { throw e instanceof ConnectionError ? new DirectoryError(e.message) : e; });
      if (c.kind === "ssh") return res.redirect(303, "/admin/connections");
      if (oauthOf(c)) return res.redirect(302, beginSignIn(c, oauthRedirect));
      await testPage(res, actor, c.id); // the secret was just typed in, so a typo shows up now rather than in a bot's chat
    }),
  );

  // an admin or a department head signs in to an OAuth mcp server for every bot that has it; the browser goes to the server's login and comes back below
  const signIn = wrap(async (req, res) => {
    const { actor } = adminOf(res);
    if (!mayEnter(actor)) return deny(res);
    const [c] = await db.select().from(connections).where(and(eq(connections.id, req.params.id), eq(connections.tenantId, actor.tenantId)));
    if (!c || !oauthOf(c) || c.status === "revoked") return page(res, 404, "No such sign-in.");
    res.redirect(302, beginSignIn(c, oauthRedirect));
  });
  // a link in the chat opens it with GET; the button on the page posts
  router.get("/connections/:id/signin", signIn);
  router.post("/connections/:id/signin", signIn);
  router.get(
    "/connections/oauth/callback",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!mayEnter(actor)) return deny(res);
      const { code, state, error } = req.query as Record<string, string | undefined>;
      if (error || !code || !state) return page(res, 400, `The sign-in did not complete${error ? ` (${error})` : ""}. Start it again from Connections.`);
      const c = await finishSignIn(connDeps, actor.tenantId, state, code).catch((e) => { throw e instanceof OAuthError ? new DirectoryError(e.message) : e; });
      // now the server talks to us: its read-only marks decide which tools run without a card
      const tools = await listMcpToolInfo(fetchFn, { target: c.target, headers: { Authorization: `Bearer ${await accessToken(connDeps, c)}` } }).catch(() => []);
      await db.update(connections).set({ config: { ...(c.config as object), readOnlyTools: tools.filter((t) => t.readOnly).map((t) => t.name) } as never }).where(eq(connections.id, c.id));
      render(res, "Signed in", html`<h1>Signed in to ${c.name}</h1><p>Every bot given this connection can use it now. ${tools.length ? `${tools.length} tools found.` : "No tools were listed; press test on the connection to check it."}</p><p><a href="${isAdmin(actor) ? "/admin/connections" : "/admin"}">Back</a></p>`);
    }),
  );

  const testPage = async (res: Response, actor: { tenantId: string; personId: string }, id: string) => {
    const output = await adminVerify(connDeps, actor.tenantId, id, actor.personId).catch((e) => (e instanceof ConnectionError ? `Failed: ${e.message}` : Promise.reject(e)));
    render(res, "Connection test", html`<h1>Connection test</h1><pre>${output}</pre><p><a href="/admin/connections">Back</a></p>`);
  };

  router.post(
    "/connections/:connectionId/verify",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      await testPage(res, actor, req.params.connectionId);
    }),
  );

  router.get(
    "/bots",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      const admin = isAdmin(actor);
      const t = personaTemplate(req.query.template);
      const [{ defs }, settings, domain] = await Promise.all([visibleBots(db, actor), getTenantSettings(db, actor.tenantId), admin ? mailDomain() : undefined]);
      render(
        res,
        "Bots",
        html`<header class="be-pagehead"><div class="pt"><h1>Bots</h1></div></header>
${await botsTable(db, actor.tenantId, defs)}${
          admin
            ? html`<details class="be-section" id="add"${t ? html` open` : ""}><summary class="be-btn">add bot…</summary>
<p class="muted">start from a template: ${PERSONA_TEMPLATES.map((p, i) => html`${i ? " · " : ""}<a href="/admin/bots?template=${p.id}#add">${p.title}</a>`)}</p>
<form method="post" action="/admin/bots">${csrfField(res)}
<p><label>name <input name="displayName" maxlength="60" value="${t?.name ?? ""}"></label> <label>handle <input name="name" required value="${t?.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ?? ""}"></label> <label>label <input name="label" required value="${t?.label ?? ""}"></label> <label>model <input name="model" value="${settings.defaultModel ?? defaultModel}"></label></p>
${domain ? html`<p><label>email address <input name="localPart" maxlength="36" autocomplete="off"></label> @${domain}</p>` : ""}
<p><label>persona<textarea name="persona" rows="10">${t?.persona ?? ""}</textarea></label></p><button class="be-btn primary">create</button></form></details>`
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
    if (!mail) return html`<div class="be-empty">Email is not set up on this server. Set AGENTMAIL_ADMIN_KEY (and AGENTMAIL_URL) in the service's environment and restart it; then each bot can get its own address here.</div>`;
    const csrf = csrfField(res, "email");
    const box = await mailboxOf(id);
    const act = (path: string, label: string, extra: SafeHtml = html``) => html`<form method="post" action="/admin/bots/${id}/${path}">${csrf}${extra}<button class="be-btn${path.endsWith("/remove") ? " danger" : ""}">${label}</button></form>`;
    if (!box) {
      const domain = await mailDomain();
      return html`<h2>Email</h2><form method="post" action="/admin/bots/${id}/mailbox">${csrf}<p><label>email address <input name="localPart" maxlength="36" autocomplete="off" required></label>${domain ? html` @${domain}` : ""}</p><button class="be-btn primary">create email address</button></form>`;
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
      sendAs = html`<h3>company address</h3>${state ? html`<p>${state}</p>` : ""}
<form method="post" action="/admin/bots/${id}/send-as">${csrf}<p><label>company address <input type="email" name="address" placeholder="name@example.com" required></label></p><button class="be-btn">save</button></form>${act("send-as/remove", "clear")}
<p>In Microsoft 365, forward the company address to ${box.address ?? ""} with a plain forward, and allow automatic forwarding in the outbound anti-spam policy.</p>`;
    }
    return html`<h2>Email</h2><dl class="be-kv"><div><dt>address</dt><dd>${box.address ?? box.localPart ?? ""}</dd></div><div><dt>status</dt><dd>${label}</dd></div></dl>${
      box.status === "active" ? act("mailbox/remove", "remove email address") : box.status === "removed" ? act("mailbox/restore", "restore email address")
        : box.status === "pending" ? act("mailbox/retry", "try again") : box.status === "removing" ? act("mailbox/remove", "finish removing") : ""
    }${sendAs}`;
  };

  /**
   * Connects to an http server the admin added, lists its tools onto the Actions tab, and starts the ones the server
   * marks read-only on "Runs freely" (only where no rule is set yet). The server is already saved; a failure says why.
   */
  const discoverTools = async (tenantId: string, definitionId: string, name: string, justAdded: boolean) => {
    const s = (await getDefinition(db, tenantId, definitionId))?.mcpServers.find((x) => x.name === name);
    if (!s) throw new DirectoryError("No such server");
    if (s.transport !== "http" || !s.url) throw new DirectoryError("Only an http server can be listed here; a stdio server's tools appear once the bot has started");
    let tools: { name: string; readOnly: boolean }[];
    try {
      tools = await listMcpToolInfo(fetchFn, { target: s.url, headers: s.headersCipher ? (JSON.parse(decrypt(secretsKey, s.headersCipher)) as Record<string, string>) : {} });
    } catch (e) {
      const why = e instanceof ConnectionError ? e.message : "it could not be reached";
      throw new DirectoryError(`${justAdded ? `${name} was saved, but its` : `${name}'s`} tools could not be listed: ${why}. Check the URL and header, then press "list tools" beside it.`);
    }
    await recordTools(db, definitionId, tools.map((t) => `mcp__${name}__${t.name}`));
    const rules = await toolRulesFor(db, definitionId);
    for (const t of tools) if (t.readOnly && !rules.has(`mcp__${name}__${t.name}`)) await setToolRule(db, definitionId, `mcp__${name}__${t.name}`, "free");
  };

  const RULE_LABEL: Record<ToolRule, string> = { free: "Runs freely", confirm: "Needs confirmation" };
  // every tool the engine announced for the bot, with its default and the admin's rule; approve-class is locked
  const actionsOf = async (def: BotDefinition, linked: Connection[]) => {
    const [tools, rules] = await Promise.all([knownTools(db, def.id), toolRulesFor(db, def.id)]);
    const readOnly = mcpReadOnly(activeMcp(linked));
    // run_code_unsafe is blocked by the runner, so a rule for it would mean nothing
    return tools.filter((t) => t !== "mcp__browser__browser_run_code_unsafe").map((tool) => {
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
    const row = (a: (typeof actions)[number]) => html`<tr><td title="${a.tool}">${toolWords(a.tool)}</td><td>${
      a.locked
        ? html`${RULE_LABEL.confirm} (locked)`
        : html`<div class="be-seg" role="radiogroup" aria-label="${a.tool}">${(["free", "confirm"] as const).map(
            (r) => html`<label><input type="radio" name="rule:${a.tool}" value="${r}" ${a.current === r ? "checked" : ""}><span>${RULE_LABEL[r]}${a.fallback === r ? " (default)" : ""}</span></label>`,
          )}</div>`
    }</td></tr>`;
    // one switch per group sets every tool in it (locked ones stay asking); "as below" keeps the rows' own choices
    const groupSwitch = (g: string) => html`<div class="be-seg" role="radiogroup" aria-label="all ${g}">${(["", "free", "confirm"] as const).map(
      (r) => html`<label><input type="radio" name="all:${g}" value="${r}" ${r === "" ? "checked" : ""}><span>${r ? `all: ${RULE_LABEL[r]}` : "as below"}</span></label>`,
    )}</div>`;
    return html`<h2>Actions</h2><p class="muted">Each choice saves as you make it.</p><form method="post" action="/admin/bots/${def.id}/actions" data-autosave>${csrfField(res, "actions")}${AUTO}${[...groups.keys()].sort().map(
      (g) => html`<h3>${g}</h3>${groups.get(g)!.length > 1 ? groupSwitch(g) : ""}${scroll(html`<table class="be-table"><tbody>${groups.get(g)!.map(row)}</tbody></table>`)}`,
    )}<p><button class="be-btn primary">save</button></p></form>`;
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
      const head = (tab?: Tab) => html`<header class="be-pagehead"><div class="pt"><nav class="crumb" aria-label="breadcrumb"><a href="/admin/bots">bots</a> / <span aria-current="page">${def.displayName ?? def.name}</span></nav><h1>${def.displayName ?? def.name} · ${def.label}</h1><p class="meta">${mb?.address ? `${mb.address} · ` : ""}${def.model} · ${chatCount.n} ${chatCount.n === 1 ? "chat" : "chats"}</p></div><div class="act"><a class="be-btn sm" href="/admin/bots/${def.id}/try">try it</a></div></header>${
        tab ? html`<nav class="be-tabs" aria-label="bot">${tabsOf(def).map((t) => html`<a href="/admin/bots/${def.id}?tab=${t}"${t === tab ? raw(' class="active" aria-current="page"') : ""}>${t === "m365" ? "Microsoft 365" : t}</a>`)}</nav>` : ""
      }`;
      const personaBox = html`<p><label>persona<textarea name="persona">${def.persona}</textarea></label></p>`;
      let body: SafeHtml;
      if (!admin) {
        body = html`${head()}<form method="post" action="/admin/bots/${def.id}">${csrfField(res)}${personaBox}<button class="be-btn primary">save</button></form>`;
      } else {
        const asked = typeof req.query.tab === "string" ? req.query.tab : "";
        const tab = tabsOf(def).find((t) => t === asked) ?? "overview";
        const csrf = csrfField(res, tab);
        const [depts, allowed, conns, linked, rts, assigned, ppl] = await Promise.all([
          listDepartments(db, actor.tenantId), allowedDepartments(db, def.id), listConnections(db, actor.tenantId), listConnectionsFor(db, actor.tenantId, def.id),
          listRoutines(db, actor.tenantId, def.id),
          db.select({ id: chats.id, label: chats.label, conversationType: chats.conversationType, lastSeenAt: chats.lastSeenAt }).from(chatAssignments).innerJoin(chats, eq(chats.id, chatAssignments.chatId))
            .where(eq(chatAssignments.definitionId, def.id)),
          db.select({ id: people.id, name: people.name }).from(people).where(eq(people.tenantId, actor.tenantId)),
        ]);
        const linkedIds = new Set(linked.map((c) => c.id));
        const chatLabel = await chatNames(db, actor.tenantId);
        const personName = new Map(ppl.map((p) => [p.id, p.name]));
        // one endpoint saves the whole definition, so each of the two forms carries the other's fields unchanged
        const person = def.identity === "person";
        const hide = (name: string, value: string) => html`<input type="hidden" name="${name}" value="${value}">`;
        const settings = (on: "overview" | "persona") => html`<form class="be-form" method="post" action="/admin/bots/${def.id}">${csrf}${
          on === "overview"
            ? html`<div class="fields">
<label>name<span class="hint">what people call it in chat</span><input name="displayName" value="${def.displayName ?? ""}" maxlength="60"></label>
<label>role<span class="hint">shown after the name</span><input name="label" value="${def.label}" required></label>
<label>model<span class="hint">a Claude model id</span><input name="model" value="${def.model}" required></label>
</div>
<p class="be-label">can use</p><p><label class="be-toggle"><input type="checkbox" name="webSearch" ${def.webSearch ? "checked" : ""}> web search and browser</label>${person ? "" : html` <label class="be-toggle"><input type="checkbox" name="computer" ${def.computer ? "checked" : ""}> a computer</label>`}</p>
${person ? html`<p class="muted">Acts as each person who uses it, in their own chat.</p>` : html`<p class="be-label">who can talk to it <span class="hint">none ticked means everyone in the company</span></p><p>${depts.map((d) => html`<label class="be-toggle"><input type="checkbox" name="departments" value="${d.id}" ${allowed.includes(d.id) ? "checked" : ""}> ${d.name}</label> `)}</p>`}${hide("persona", def.persona)}`
            : html`${personaBox}${hide("displayName", def.displayName ?? "")}${hide("label", def.label)}${hide("model", def.model)}${def.webSearch ? hide("webSearch", "on") : ""}${def.computer ? hide("computer", "on") : ""}${person ? "" : allowed.map((d) => hide("departments", d))}`
        }<p><button class="be-btn primary">save</button></p></form>`;
        let section: SafeHtml;
        if (tab === "overview") {
          section = settings("overview");
        } else if (tab === "m365") {
          section = html`<p class="muted">What each person's assistant may do in their Microsoft 365, as them. Sending and changing still ask in the chat unless an admin sets the action free on the Actions tab.</p>
<form method="post" action="/admin/bots/${def.id}/m365">${csrf}<p>${GRAPH_CAPABILITIES.map((c) => html`<label class="be-toggle"><input type="checkbox" name="graph" value="${c}" ${def.graph.includes(c) ? "checked" : ""}> ${capabilityWords(c)}</label> `)}</p><p><button class="be-btn primary">save</button></p></form>`;
        } else if (tab === "persona") {
          section = settings("persona");
        } else if (tab === "email") {
          section = await mailSectionFor(res, def.id);
        } else if (tab === "actions") {
          section = await actionsSectionFor(res, def, linked);
        } else if (tab === "connections") {
          // the company's connections, split by whether this bot uses them: one list per question an admin asks
          const connRow = (c: Connection, uses: boolean) => html`<tr><td>${c.name}</td><td>${c.kind}</td><td>${c.target}</td><td>${c.mode}</td><td>${c.status}${signInCell(c, csrf)}</td>
<td><form method="post" action="/admin/bots/${def.id}/connections/${c.id}/link">${csrf}<input type="hidden" name="linked" value="${uses ? "off" : "on"}"><button class="be-btn sm${uses ? "" : " primary"}">${uses ? "take away" : "give to this bot"}</button></form>${
            c.status === "blocked" ? html`<form method="post" action="/admin/connections/${c.id}/reset-host-key">${csrf}<button class="be-btn sm">reset host key</button></form>` : ""}</td>
<td><form method="post" action="/admin/connections/${c.id}/revoke">${csrf}<button class="be-btn sm danger" title="switches it off for every bot and deletes its secret">revoke for all bots</button></form></td></tr>`;
          const connTable = (list: Connection[], uses: boolean) =>
            scroll(html`<table class="be-table"><thead><tr><th>Name</th><th>Kind</th><th>Target</th><th>Mode</th><th>Status</th><th></th><th></th></tr></thead><tbody>${list.map((c) => connRow(c, uses))}</tbody></table>`);
          const mine = conns.filter((c) => linkedIds.has(c.id));
          const others = conns.filter((c) => !linkedIds.has(c.id) && c.status !== "revoked");
          section = html`<h2>Connections this bot uses</h2>
${mine.length ? connTable(mine, true) : html`<div class="be-empty">none yet: ${others.length ? "give it one below" : html`add an ssh, sql, MCP or http connection on the <a href="/admin/connections#add">Connections page</a>`}, or ask the bot in chat to set one up</div>`}
${others.length ? html`<h2>Other company connections</h2>${connTable(others, false)}` : ""}
<h2>MCP servers</h2>
${def.mcpServers.length ? scroll(html`<table class="be-table"><thead><tr><th>Name</th><th>Transport</th><th>Read-only tools</th><th>Headers</th><th></th><th></th></tr></thead><tbody>${def.mcpServers.map(
            (s) => html`<tr><td>${s.name}</td><td>${s.transport}</td><td>${s.readOnlyTools.join(", ") || "none"}</td><td>${s.headersCipher ? "headers set" : "none"}</td><td>${s.transport === "http" ? html`<form method="post" action="/admin/bots/${def.id}/servers/${encodeURIComponent(s.name)}/tools">${csrf}<button class="be-btn sm" title="connects, lists its tools on the Actions tab so you can choose which run freely">list tools</button></form>` : ""}</td><td><form method="post" action="/admin/bots/${def.id}/servers/${encodeURIComponent(s.name)}/delete">${csrf}<button class="be-btn sm danger">remove</button></form></td></tr>`,
          )}</tbody></table>`) : html`<div class="be-empty">no MCP servers</div>`}
<details class="add"><summary>add an MCP server…</summary>
<form method="post" action="/admin/bots/${def.id}/servers">${csrf}
<p><label>paste a claude mcp add command<span class="hint">fills in everything below; the header is stored encrypted</span><textarea name="commandLine" rows="3" autocomplete="off" spellcheck="false" placeholder="claude mcp add --transport http name https://… --header &quot;Authorization: Bearer …&quot;"></textarea></label></p>
<p class="muted">or fill in:</p>
<div class="fields">
<label>name<input name="name" required></label>
<label>transport<select name="transport"><option>http</option><option>stdio</option></select></label>
<label>url<span class="hint">http only</span><input name="url" placeholder="https://…"></label>
<label>command<span class="hint">stdio only</span><input name="command"></label>
<label>args<span class="hint">stdio only, space separated</span><input name="args"></label>
<label>header name<span class="hint">optional, e.g. Authorization</span><input name="headerName"></label>
<label>header value<span class="hint">stored encrypted, never shown again</span><input type="password" name="headerValue" autocomplete="off"></label>
<label>read-only tools<span class="hint">comma separated; these run without a card</span><input name="readOnlyTools"></label>
</div>
<button class="be-btn primary">add server</button></form></details>`;
        } else if (tab === "routines") {
          const { timezone } = await getTenantSettings(db, actor.tenantId);
          const when = whenIn(timezone);
          const kind = (r: (typeof rts)[number]) => (r.schedule ? "repeats" : r.background ? "background job" : "reminder");
          const row = (r: (typeof rts)[number]) => html`<tr><td>${r.prompt.slice(0, 80)}</td><td>${kind(r)}</td><td>${r.schedule ? html`<span title="${r.schedule}">${cronWords(r.schedule)}</span>` : when(r.runAt)}</td><td>${chatLabel.get(r.chatId) ?? r.chatId.slice(-12)}</td><td>${yesNo(r.quiet)}</td><td>${yesNo(r.enabled)}</td><td>${r.grantPersonId ? (personName.get(r.grantPersonId) ?? "—") : "—"}</td>
<td>${r.schedule || r.enabled ? html`<form method="post" action="/admin/bots/${def.id}/routines/${r.id}/enabled">${csrf}<input type="hidden" name="enabled" value="${r.enabled ? "off" : "on"}"><button class="be-btn sm">${r.enabled ? "disable" : "enable"}</button></form>` : ""}
<form method="post" action="/admin/bots/${def.id}/routines/${r.id}/delete">${csrf}<button class="be-btn sm danger">delete</button></form></td></tr>`;
          const table = (rows: typeof rts) => scroll(html`<table class="be-table"><thead><tr><th>Prompt</th><th>Kind</th><th>When</th><th>Chat</th><th>Quiet</th><th>Enabled</th><th>Grant</th><th></th></tr></thead><tbody>${rows.map(row)}</tbody></table>`);
          // a one-off that has run is finished history, not something waiting
          const ran = rts.filter((r) => !r.schedule && r.lastRunAt);
          const live = rts.filter((r) => !ran.includes(r));
          section = html`<h2>Routines and reminders</h2>
${live.length ? table(live) : html`<div class="be-empty">Nothing waiting or repeating.</div>`}
${ran.length ? html`<details><summary>already ran (${ran.length})</summary>${table(ran)}</details>` : ""}
<form class="be-form" method="post" action="/admin/bots/${def.id}/routines">${csrf}
<div class="fields"><label>chat<span class="hint">where it runs and posts</span><select name="chatId">${assigned.map((c) => html`<option value="${c.id}">${chatLabel.get(c.id)}</option>`)}</select></label> <label>schedule<span class="hint">cron: minute hour day month weekday, e.g. 0 9 * * 1-5 is weekdays 9:00 am</span><input name="schedule" placeholder="0 9 * * 1-5" required></label></div>
<p><label class="be-toggle"><input type="checkbox" name="quiet"> quiet: post only when it changed something</label> <label class="be-toggle"><input type="checkbox" name="grant"> grant my access: changes run without a card</label></p>
<p><label class="be-label">prompt<textarea name="prompt" required></textarea></label></p><button class="be-btn primary">add routine</button></form>`;
        } else if (tab === "learnings") {
          const rows = await listLearnings(db, actor.tenantId, def.id);
          const day = await whenFor(db, actor.tenantId);
          // each row is its own form, so an admin rewords one teaching in place
          const row = (l: (typeof rows)[number]) => html`<tr><td><form method="post" action="/admin/bots/${def.id}/learnings/${l.id}">${csrf}<textarea name="text" rows="2" required>${l.text}</textarea><button class="be-btn sm">save</button></form></td>
<td>${personName.get(l.taughtByPersonId) ?? "—"}</td><td>${l.chatId ? (chatLabel.get(l.chatId) ?? l.chatId.slice(-12)) : "admin site"}</td><td>${l.ownerPersonId ? `only ${personName.get(l.ownerPersonId) ?? "one person"}` : "everyone"}</td><td>${day(l.updatedAt)}</td>
<td><form method="post" action="/admin/bots/${def.id}/learnings/${l.id}/delete">${csrf}<button class="be-btn sm danger">delete</button></form></td></tr>`;
          section = html`<h2>Learnings</h2>
<p class="hint">What people have taught this bot in chats. Each one is in the bot's instructions from the next message on.</p>
${rows.length ? scroll(html`<table class="be-table"><thead><tr><th>Learning</th><th>Taught by</th><th>Where</th><th>Applies to</th><th>Changed</th><th></th></tr></thead><tbody>${rows.map(row)}</tbody></table>`) : html`<div class="be-empty">Nothing learnt yet.</div>`}
<form method="post" action="/admin/bots/${def.id}/learnings">${csrf}<p><label>new learning<textarea name="text" required placeholder="Call scheduled runs reminders"></textarea></label></p><button class="be-btn">add learning</button></form>`;
        } else {
          // the chats this bot answers in; who and when come from the same place Assignments shows them
          const seen = await whenFor(db, actor.tenantId);
          section = assigned.length
            ? html`${scroll(html`<table class="be-table"><thead><tr><th>Chat</th><th>Type</th><th>Last message</th><th></th></tr></thead><tbody>${assigned.map(
                (c) => html`<tr><td>${chatLabel.get(c.id)}</td><td>${chatTypeWords(c.conversationType)}</td><td>${seen(c.lastSeenAt)}</td><td><a href="/admin/assignments">change on Assignments</a></td></tr>`,
              )}</tbody></table>`)}`
            : html`<div class="be-empty">No chats yet. An admin puts a bot in a group chat by typing "switch" there, or on <a href="/admin/assignments">Assignments</a>.</div>`;
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
        // first, so a refused save changes nothing
        await setAllowedDepartments(db, actor.tenantId, id, many(req, "departments"));
        await updateDefinitionFields(db, actor.tenantId, id, {
          displayName: "displayName" in ((req.body as object) ?? {}) ? field(req, "displayName") : undefined, label: field(req, "label").trim(), persona: field(req, "persona"), model: field(req, "model").trim(),
          webSearch: field(req, "webSearch") === "on", computer: field(req, "computer") === "on",
        });
        onSaved?.(id);
      }
      res.redirect(303, back(req, id));
    }),
  );

  router.post(
    "/bots/:id/m365",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      await setGraph(db, actor.tenantId, req.params.id, many(req, "graph"));
      onSaved?.(req.params.id);
      res.redirect(303, `/admin/bots/${req.params.id}?tab=m365`);
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
        await serviceBot(actor.tenantId, req.params.id);
        if ((path === "mailbox/remove" || path === "send-as/remove") && !isArmed(req)) return armed(res, req, path === "send-as/remove" ? "Clear company address?" : "Remove email address?", path === "send-as/remove" ? "confirm clear?" : "confirm remove?", back(req, req.params.id));
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
        const all = field(req, `all:${toolSource(a.tool)}`);
        if (a.locked && all === "free") continue;
        const want = all === "free" || all === "confirm" ? all : field(req, `rule:${a.tool}`);
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
      await serviceBot(actor.tenantId, req.params.id);
      const headerName = field(req, "headerName").trim();
      const headerValue = field(req, "headerValue");
      if (!headerName !== !headerValue) throw new DirectoryError("Header name and value go together");
      if (headerName && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName)) throw new DirectoryError("Invalid header name");
      if (headerValue && (/[\r\n\0]/.test(headerValue) || !headerValue.trim())) throw new DirectoryError("Invalid header value");
      const transport = field(req, "transport");
      const pasted = field(req, "commandLine").trim();
      const server = pasted
        ? parseMcpAdd(pasted)
        : {
            name: field(req, "name").trim(),
            transport: transport as "http" | "stdio", // zod rejects anything else
            url: field(req, "url").trim() || undefined,
            command: field(req, "command").trim() || undefined,
            args: list(field(req, "args")),
            headers: headerName ? { [headerName]: headerValue } : undefined,
          };
      await addMcpServer(db, secretsKey, actor.tenantId, req.params.id, { ...server, readOnlyTools: list(field(req, "readOnlyTools")) });
      if (server.transport === "http") await discoverTools(actor.tenantId, req.params.id, server.name, true);
      res.redirect(303, server.transport === "http" ? `/admin/bots/${req.params.id}?tab=actions` : back(req, req.params.id));
    }),
  );

  router.post(
    "/bots/:id/servers/:name/tools",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      await serviceBot(actor.tenantId, req.params.id);
      await discoverTools(actor.tenantId, req.params.id, req.params.name, false);
      res.redirect(303, `/admin/bots/${req.params.id}?tab=actions`);
    }),
  );

  router.post(
    "/bots/:id/servers/:name/delete",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      if (!isArmed(req)) return armed(res, req, "Remove server?", "confirm remove?", back(req, req.params.id));
      await removeMcpServer(db, actor.tenantId, req.params.id, req.params.name);
      res.redirect(303, back(req, req.params.id));
    }),
  );

  router.post(
    "/bots/:id/connections/:connectionId/link",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      await serviceBot(actor.tenantId, req.params.id);
      await setLinked(db, actor.tenantId, req.params.id, req.params.connectionId, field(req, "linked") === "on");
      res.redirect(303, back(req, req.params.id));
    }),
  );

  router.post(
    "/connections/:connectionId/revoke",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      if (!isArmed(req)) return armed(res, req, "Revoke connection?", "confirm revoke?", "/admin/connections");
      const c = await revokeConnection(db, actor.tenantId, req.params.connectionId);
      render(res, "Revoked", html`<h1>Revoked ${c.name}</h1>${
        c.kind === "ssh" && c.publicKey
          ? html`<p>Remove this line from the target's authorized_keys:</p><pre>${c.publicKey}</pre>`
          : html`<p>Revoke the token at its source.</p>`
      }<p><a href="/admin/connections">Back</a></p>`);
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

  router.post(
    "/bots/:id/learnings",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      if (!(await getDefinition(db, actor.tenantId, req.params.id))) throw new DirectoryError("No such bot");
      await addLearning(db, actor.tenantId, { definitionId: req.params.id, text: field(req, "text"), taughtByPersonId: actor.personId });
      res.redirect(303, back(req, req.params.id));
    }),
  );

  router.post(
    "/bots/:id/learnings/:lid",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      await updateLearning(db, actor.tenantId, req.params.id, req.params.lid, field(req, "text"));
      res.redirect(303, back(req, req.params.id));
    }),
  );

  router.post(
    "/bots/:id/learnings/:lid/delete",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return deny(res);
      if (!(await listLearnings(db, actor.tenantId, req.params.id)).some((l) => l.id === req.params.lid)) throw new DirectoryError("No such learning");
      if (!isArmed(req)) return armed(res, req, "Delete learning?", "confirm delete?", back(req, req.params.id));
      await deleteLearning(db, actor.tenantId, req.params.id, req.params.lid);
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
      if (!isArmed(req)) return armed(res, req, "Delete routine?", "confirm delete?", back(req, req.params.id));
      await deleteRoutine(db, actor.tenantId, req.params.rid);
      res.redirect(303, back(req, req.params.id));
    }),
  );

  return router;
}
