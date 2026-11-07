import express from "express";
import type { Request, Router } from "express";
import { and, asc, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { chats } from "../db/schema.js";
import { DirectoryError } from "../org/directory.js";
import { resolveModel } from "../engine/providers.js";
import { getTenantSettings, setTenantSettings } from "../org/org.js";
import { reflectionModes } from "../reflections/store.js";
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
      const groups = await db
        .select({ id: chats.id, label: chats.label, type: chats.conversationType })
        .from(chats)
        .where(and(eq(chats.tenantId, actor.tenantId), ne(chats.conversationType, "personal")))
        .orderBy(asc(chats.label));
      res.type("html").send(
        layout({
          title: "Settings",
          body: html`${pageHead("Settings")}
<form class="be-form" method="post" action="/admin/settings"><input type="hidden" name="csrf" value="${csrf}">
<div class="fields">
<label>bot name<span class="hint">how the bots introduce themselves in Teams</span><input class="be-input" name="botName" value="${s.botName ?? ""}" maxlength="40"></label>
<label>default model<span class="hint">a provider/model id; a bot without its own uses this</span><input class="be-input" name="defaultModel" value="${s.defaultModel ?? ""}" placeholder="deepseek/deepseek-flash"></label>
<label>keep activity<span class="hint">days before the activity log and kept group messages are deleted</span><input class="be-input" name="retentionDays" type="number" min="1" max="3650" value="${s.retentionDays}" required></label>
<label>time zone<span class="hint">the company's; each person's Teams zone wins for them</span><input class="be-input" name="timezone" value="${s.timezone}" required placeholder="Australia/Sydney"></label>
<label>location<span class="hint">city; filled from the directory until you set it</span><input class="be-input" name="location" value="${s.location ?? ""}" maxlength="80" placeholder="Melbourne"></label>
<label>country<input class="be-input" name="country" value="${s.country ?? ""}" maxlength="80" placeholder="Australia"></label>
<label>daily reflection<span class="hint">each bot reviews its day at the chosen hour. propose: learnings wait for an admin. auto: learnings apply and the bot posts what it learnt to the group.</span><select class="be-select" name="reflectionMode">${reflectionModes.map((m) => html`<option value="${m}" ${m === s.reflectionMode ? "selected" : ""}>${m === "off" ? "off" : m === "propose" ? "2 · propose learnings for approval" : "3 · apply and post to the group"}</option>`)}</select></label>
<label>reflection group<span class="hint">the group chat an auto reflection posts to; the bot must have been in it</span><select class="be-select" name="reflectionChatId"><option value="">none</option>${groups.map((g) => html`<option value="${g.id}" ${g.id === s.reflectionChatId ? "selected" : ""}>${g.label ?? g.id} · ${g.type}</option>`)}</select></label>
<label>reflection hour<span class="hint">0-23 in the company time zone</span><input class="be-input" type="number" min="0" max="23" name="reflectionHour" value="${s.reflectionHour}" required></label>
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
      const current = await getTenantSettings(db, actor.tenantId);
      // the form always sends the reflection fields; a client that omits one keeps the current value
      const has = (name: string) => Object.prototype.hasOwnProperty.call(req.body ?? {}, name);
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
      const reflectionMode = has("reflectionMode") ? field(req, "reflectionMode") || "off" : current.reflectionMode;
      if (!reflectionModes.includes(reflectionMode as (typeof reflectionModes)[number])) throw new DirectoryError("Unknown reflection mode");
      const reflectionHour = has("reflectionHour") ? Number(field(req, "reflectionHour")) : current.reflectionHour;
      if (!Number.isInteger(reflectionHour) || reflectionHour < 0 || reflectionHour > 23) throw new DirectoryError("Reflection hour must be a whole number from 0 to 23");
      const reflectionChatId = has("reflectionChatId") ? field(req, "reflectionChatId") || null : current.reflectionChatId;
      if (reflectionChatId) {
        const [chat] = await db.select({ type: chats.conversationType }).from(chats).where(and(eq(chats.id, reflectionChatId), eq(chats.tenantId, actor.tenantId)));
        if (!chat || chat.type === "personal") throw new DirectoryError("The reflection group must be a group chat or channel in this company");
      }
      if (reflectionMode === "auto" && !reflectionChatId) throw new DirectoryError("Choose a group chat for auto mode, or use propose mode");
      await setTenantSettings(db, actor.tenantId, {
        botName,
        retentionDays,
        defaultModel,
        timezone: field(req, "timezone") || current.timezone,
        location: place("location"),
        country: place("country"),
        reflectionMode,
        reflectionChatId,
        reflectionHour,
      });
      res.redirect(303, "/admin/settings");
    }),
  );

  return router;
}
