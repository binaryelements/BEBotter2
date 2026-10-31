import express from "express";
import type { Request, Router } from "express";
import type { Db } from "../db/client.js";
import { DirectoryError } from "../org/directory.js";
import { getTenantSettings, setTenantSettings } from "../org/org.js";
import { isAdmin } from "./access.js";
import { html, layout } from "./html.js";
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
          body: html`<h1>Settings</h1>
<form method="post" action="/admin/settings"><input type="hidden" name="csrf" value="${csrf}">
<p><label>Bot name <input name="botName" value="${s.botName ?? ""}" maxlength="40"></label></p>
<p><label>Keep activity (days) <input name="retentionDays" type="number" min="1" max="3650" value="${s.retentionDays}" required></label></p>
<p><label>Default model <input name="defaultModel" value="${s.defaultModel ?? ""}"></label></p>
<button>Save</button></form>`,
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
      await setTenantSettings(db, actor.tenantId, { botName, retentionDays, defaultModel });
      res.redirect(303, "/admin/settings");
    }),
  );

  return router;
}
