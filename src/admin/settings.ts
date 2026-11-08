import express from "express";
import type { Request, Router } from "express";
import type { Db } from "../db/client.js";
import { DirectoryError } from "../org/directory.js";
import { resolveModel } from "../engine/providers.js";
import { getTenantSettings, setTenantSettings } from "../org/org.js";
import { getDefinition, listDefinitions } from "../bots/definitions.js";
import { sendTestAlert } from "../alerts/alert.js";
import { MailError } from "../mail/agentmail.js";
import type { agentMailAdmin } from "../mail/agentmail.js";
import { isAdmin } from "./access.js";
import { html, layout, pageHead } from "./html.js";
import type { BalanceReader } from "../engine/balances.js";
import { adminOf, wrap } from "./http.js";
import { page } from "./oidc.js";

const field = (req: Request, name: string) => {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof v === "string" ? v.trim() : "";
};

export function settingsRoutes(db: Db, models?: string[], balance?: BalanceReader, admin?: ReturnType<typeof agentMailAdmin>): Router {
  const router = express.Router();
  // the configured models, plus the current one if it is no longer offered, so a save never silently changes it
  const modelOptions = (current: string | null) => {
    const list = models?.length ? models : current ? [current] : [];
    const all = current && !list.includes(current) ? [current, ...list] : list;
    return html`<option value="">not set</option>${all.map((m) => html`<option value="${m}" ${m === current ? "selected" : ""}>${m}</option>`)}`;
  };

  router.get(
    "/settings",
    wrap(async (_req, res) => {
      const { actor, csrf } = adminOf(res);
      if (!isAdmin(actor)) return page(res, 403, "Not allowed.");
      const s = await getTenantSettings(db, actor.tenantId);
      const wallet = balance ? await balance().catch(() => undefined) : undefined;
      const bots = (await listDefinitions(db, actor.tenantId)).filter((d) => d.identity !== "person");
      res.type("html").send(
        layout({
          title: "Settings",
          body: html`${pageHead("Settings", html`<button class="be-btn primary" type="submit" form="settings-form">Save changes</button>`)}
<form id="settings-form" method="post" action="/admin/settings"><input type="hidden" name="csrf" value="${csrf}">
<div class="grid-2">
<section class="be-card">
<h2>Company</h2>
<p class="muted small">How the bots introduce themselves and where they think they are.</p>
<div class="form-grid">
<div class="field"><label for="s-botname">Bot name</label><input id="s-botname" class="be-input" name="botName" value="${s.botName ?? ""}" maxlength="40"><div class="hint">Used when a bot introduces itself in Teams.</div></div>
<div class="field"><label for="s-timezone">Time zone</label><input id="s-timezone" class="be-input" name="timezone" value="${s.timezone}" required placeholder="Australia/Sydney"><div class="hint">The company's; each person's Teams zone wins for them.</div></div>
<div class="field"><label for="s-location">Location</label><input id="s-location" class="be-input" name="location" value="${s.location ?? ""}" maxlength="80" placeholder="Melbourne"><div class="hint">City; filled from the directory until you set it.</div></div>
<div class="field"><label for="s-country">Country</label><input id="s-country" class="be-input" name="country" value="${s.country ?? ""}" maxlength="80" placeholder="Australia"></div>
</div>
</section>
<section class="be-card">
<h2>Models</h2>
<p class="muted small">The default for a bot without its own. Per-bot models are on the bot's Overview tab.</p>
<div class="form-grid">
<div class="field wide"><label for="s-model">Default model</label><select id="s-model" class="be-select" name="defaultModel">${modelOptions(s.defaultModel)}</select><div class="hint">Flash is the value default; Pro is for hard troubleshooting and research.</div></div>
</div>
${wallet ? html`<div class="be-notice ${!wallet.available || wallet.total < 5 ? "warn" : ""}" style="margin-top:14px"><div class="grow"><b>DeepSeek balance: ${wallet.currency === "USD" ? "$" : ""}${wallet.total.toFixed(2)}</b><div class="meta">${wallet.available ? `Checked ${wallet.checkedAt.toISOString().slice(0, 16).replace("T", " ")} UTC. Top up when it gets low.` : (wallet.error ?? "Could not check the balance.")}</div></div></div>` : ""}
</section>
</div>
<div class="grid-2 section">
<section class="be-card">
<h2>Notifications</h2>
<p class="muted small">What the admin site tells you, and where.</p>
<div class="list">
<div class="list-row"><div class="grow"><div class="name">Saves and failures</div><div class="meta">A toast after every save; a failed save returns to the page with the reason.</div></div><span class="be-chip g">on</span></div>
<div class="list-row"><div class="grow"><div class="name">Approvals waiting</div><div class="meta">Shown on the dashboard and in Activity until they expire.</div></div><span class="be-chip g">on</span></div>
<div class="list-row"><div class="grow"><div class="name">Tool failures</div><div class="meta">Counted on the dashboard and listed in Activity.</div></div><span class="be-chip g">on</span></div>
</div>
</section>
<section class="be-card">
<h2>Retention</h2>
<p class="muted small">How long the activity log and kept group messages stay.</p>
<div class="form-grid">
<div class="field"><label for="s-retention">Keep activity</label><input id="s-retention" class="be-input" name="retentionDays" type="number" min="1" max="3650" value="${s.retentionDays}" required><div class="hint">Days. 1–3650.</div></div>
</div>
<div class="be-notice warn" style="margin-top:16px"><div class="grow"><b>Retention is a hard delete</b><div class="meta">Rows older than the window are removed on the next prune. Export first if you need them.</div></div></div>
</section>
</div>
<section class="be-card section">
<h2>Alerts</h2>
<p class="muted small">Email the admin team when something needs attention. Alerts are sent from <code>teammate-admin@eml.binaryelements.com</code>.</p>
<div class="form-grid">
<div class="field"><label for="s-alert-bot">Alert from</label><select id="s-alert-bot" class="be-select" name="alertBotId"><option value="">BE Teammate</option>${bots.map((b) => html`<option value="${b.id}" ${b.id === s.alertBotId ? "selected" : ""}>${b.displayName ? `${b.displayName} · ${b.label}` : b.label}</option>`)}</select><div class="hint">The bot's name signs the email.</div></div>
<div class="field"><label for="s-alert-emails">Send to</label><input id="s-alert-emails" class="be-input" name="alertEmails" value="${s.alertEmails ?? ""}" placeholder="ops@example.com, ann@example.com"><div class="hint">Comma separated. Alerts and the daily report go here.</div></div>
<div class="field"><label for="s-alert-threshold">Low balance threshold</label><input id="s-alert-threshold" class="be-input" type="number" min="0" max="10000" name="alertBalanceThreshold" value="${s.alertBalanceThreshold ?? 5}"><div class="hint">USD. Alert when the DeepSeek balance is below this.</div></div>
<div class="field"><label for="s-report-hour">Daily report hour</label><input id="s-report-hour" class="be-input" type="number" min="0" max="23" name="reportHour" value="${s.reportHour ?? 8}"><div class="hint">Local hour in the company time zone. The report goes to the same recipients.</div></div>
</div>
<div class="list" style="margin-top:14px">
<div class="list-row"><div class="grow"><div class="name">Daily report</div><div class="meta">A summary of replies, actions, spend, failures and the balance.</div></div><label class="be-toggle"><input type="checkbox" name="reportEnabled" ${s.reportEnabled ? "checked" : ""}> on</label></div>
<div class="list-row"><div class="grow"><div class="name">Low DeepSeek balance</div><div class="meta">Email when the provider balance drops below the threshold.</div></div><label class="be-toggle"><input type="checkbox" name="alertLowBalance" ${s.alertLowBalance ? "checked" : ""}> on</label></div>
<div class="list-row"><div class="grow"><div class="name">Failed actions</div><div class="meta">Email when a tool, connection or mail action fails.</div></div><label class="be-toggle"><input type="checkbox" name="alertFailures" ${s.alertFailures ? "checked" : ""}> on</label></div>
<div class="list-row"><div class="grow"><div class="name">Approvals waiting</div><div class="meta">Email when a confirmation card is still waiting after 10 minutes.</div></div><label class="be-toggle"><input type="checkbox" name="alertApprovals" ${s.alertApprovals ? "checked" : ""}> on</label></div>
</div>
<div class="savebar"><span class="muted small">Alerts are sent from teammate-admin@eml.binaryelements.com.</span><div class="spacer"></div><button class="be-btn" type="submit" form="alert-test">Send a test alert</button></div>
</section>
<p class="muted small">Every bot is told the time and place on every message; anything said otherwise in a chat wins there.</p>
<div class="savebar"><span class="muted small">Changes apply to every bot that does not set its own.</span><div class="spacer"></div><button class="be-btn primary">Save changes</button></div>
</form>
<form id="alert-test" method="post" action="/admin/settings/alert-test"><input type="hidden" name="csrf" value="${csrf}"></form>`,
          actor,
          csrf,
        }),
      );
    }),
  );

  router.post(
    "/settings",
    wrap(async (req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return page(res, 403, "Not allowed.");
      const botName = field(req, "botName") || null;
      if (botName && botName.length > 40) throw new DirectoryError("Bot name is too long (40 characters at most)");
      const days = field(req, "retentionDays");
      const retentionDays = /^\d+$/.test(days) ? Number(days) : NaN;
      if (!(retentionDays >= 1 && retentionDays <= 3650)) throw new DirectoryError("Keep activity must be a whole number of days from 1 to 3650");
      const defaultModel = field(req, "defaultModel") || null;
      if (defaultModel && !resolveModel(defaultModel)) throw new DirectoryError("Default model is not a known model id");
      const place = (key: "location" | "country") => {
        const v = field(req, key);
        if (v.length > 80) throw new DirectoryError(`${key === "location" ? "Location" : "Country"} is too long (80 characters at most)`);
        return v || null;
      };
      const alertBotId = field(req, "alertBotId") || null;
      const hasAlertForm = Object.prototype.hasOwnProperty.call((req.body ?? {}) as Record<string, unknown>, "alertEmails");
      if (hasAlertForm && alertBotId) {
        const bot = await getDefinition(db, actor.tenantId, alertBotId);
        if (!bot || bot.identity === "person") throw new DirectoryError("Choose a service bot for alerts");
      }
      const alertEmails = field(req, "alertEmails") || null;
      if (hasAlertForm && alertEmails && alertEmails.length > 500) throw new DirectoryError("Alert recipients are too long (500 characters at most)");
      const alertBalanceThreshold = Number(field(req, "alertBalanceThreshold") || "5");
      if (hasAlertForm && !(Number.isFinite(alertBalanceThreshold) && alertBalanceThreshold >= 0 && alertBalanceThreshold <= 10000))
        throw new DirectoryError("The balance threshold must be between 0 and 10000");
      const reportHour = Number(field(req, "reportHour") || "8");
      if (hasAlertForm && !(Number.isInteger(reportHour) && reportHour >= 0 && reportHour <= 23)) throw new DirectoryError("The daily report hour must be between 0 and 23");
      const current = await getTenantSettings(db, actor.tenantId);
      await setTenantSettings(db, actor.tenantId, {
        botName,
        retentionDays,
        defaultModel,
        timezone: field(req, "timezone") || current.timezone,
        location: place("location"),
        country: place("country"),
        ...(hasAlertForm
          ? {
              alertBotId,
              alertEmails,
              alertLowBalance: field(req, "alertLowBalance") === "on",
              alertFailures: field(req, "alertFailures") === "on",
              alertApprovals: field(req, "alertApprovals") === "on",
              alertBalanceThreshold,
              reportEnabled: field(req, "reportEnabled") === "on",
              reportHour,
            }
          : {}),
      });
      res.redirect(303, "/admin/settings");
    }),
  );

  router.post(
    "/settings/alert-test",
    wrap(async (_req, res) => {
      const { actor } = adminOf(res);
      if (!isAdmin(actor)) return page(res, 403, "Not allowed.");
      if (!admin) throw new DirectoryError("Email is not set up on this server");
      try {
        if (!(await sendTestAlert({ db, admin }, actor.tenantId))) throw new DirectoryError("Add at least one recipient email first");
      } catch (e) {
        if (e instanceof DirectoryError) throw e;
        throw new DirectoryError(e instanceof MailError ? `The test alert could not be sent: ${e.message}` : "The test alert could not be sent");
      }
      res.redirect(303, "/admin/settings");
    }),
  );

  return router;
}
