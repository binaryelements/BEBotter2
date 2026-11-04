import express from "express";
import type { Request, Router } from "express";
import type { Db } from "../db/client.js";
import { DirectoryError } from "../org/directory.js";
import { getTenantSettings, setTenantSettings } from "../org/org.js";
import { isAdmin } from "./access.js";
import { html, layout, pageHead } from "./html.js";
import { adminOf, wrap } from "./http.js";
import { page } from "./oidc.js";

const field = (req: Request, name: string) => {
  const v = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof v === "string" ? v.trim() : "";
};

export function settingsRoutes(db: Db): Router {
  const router = express.Router();

  router.get(
    "/settings",
    wrap(async (_req, res) => {
      const { actor, csrf } = adminOf(res);
      if (!isAdmin(actor)) return page(res, 403, "Not allowed.");
      const s = await getTenantSettings(db, actor.tenantId);
      res.type("html").send(
        layout({
          title: "Settings",
          body: html`${pageHead("Settings")}
<form class="be-form" method="post" action="/admin/settings"><input type="hidden" name="csrf" value="${csrf}">
<div class="fields">
<label>bot name<span class="hint">how the bots introduce themselves in Teams</span><input class="be-input" name="botName" value="${s.botName ?? ""}" maxlength="40"></label>
<label>default model<span class="hint">a Claude model id; a bot without its own uses this</span><input class="be-input" name="defaultModel" value="${s.defaultModel ?? ""}" placeholder="claude-sonnet-5-5"></label>
<label>keep activity<span class="hint">days before the activity log and kept group messages are deleted</span><input class="be-input" name="retentionDays" type="number" min="1" max="3650" value="${s.retentionDays}" required></label>
<label>time zone<span class="hint">the company's; each person's Teams zone wins for them</span><input class="be-input" name="timezone" value="${s.timezone}" required placeholder="Australia/Sydney"></label>
<label>location<span class="hint">city; filled from the directory until you set it</span><input class="be-input" name="location" value="${s.location ?? ""}" maxlength="80" placeholder="Melbourne"></label>
<label>country<input class="be-input" name="country" value="${s.country ?? ""}" maxlength="80" placeholder="Australia"></label>
</div>
<p class="muted">Every bot is told the time and place on every message; anything said otherwise in a chat wins there.</p>
<button class="be-btn primary">save</button></form>`,
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
      if (defaultModel && !/^claude-[a-z0-9-]+$/.test(defaultModel)) throw new DirectoryError("Default model is not a valid model id");
      const place = (key: "location" | "country") => {
        const v = field(req, key);
        if (v.length > 80) throw new DirectoryError(`${key === "location" ? "Location" : "Country"} is too long (80 characters at most)`);
        return v || null;
      };
      await setTenantSettings(db, actor.tenantId, { botName, retentionDays, defaultModel, timezone: field(req, "timezone") || (await getTenantSettings(db, actor.tenantId)).timezone, location: place("location"), country: place("country") });
      res.redirect(303, "/admin/settings");
    }),
  );

  return router;
}
