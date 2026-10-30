import express from "express";
import type { Router } from "express";
import type { Db } from "../db/client.js";
import { hashToken, secretLinkConnection, useSecretLink } from "../connections/secret-links.js";
import { loadActor } from "./access.js";
import { html, layout } from "./html.js";
import { wrap } from "./http.js";
import { page } from "./oidc.js";
import { csrfOk, readSession, sessionKey } from "./session.js";

/** The one-time secret page: any signed-in person of the tenant reaches it; the link itself must be theirs. */
export function secretRoutes(db: Db, secretsKey: Buffer): Router {
  const sKey = sessionKey(secretsKey);
  const router = express.Router();

  router.all(
    "/secret/:token",
    wrap(async (req, res) => {
      const token = req.params.token;
      const session = readSession(sKey, req.headers.cookie);
      if (!session) {
        if (req.method === "GET") return res.redirect(303, `/admin/auth/login?returnTo=${encodeURIComponent(`/admin/secret/${token}`)}`);
        return page(res, 403, "Not allowed.");
      }
      if (!(await loadActor(db, session.tenantId, session.personId))) return page(res, 403, "Not allowed.");
      const hash = hashToken(token);

      if (req.method === "GET") {
        const c = await secretLinkConnection(db, hash, session.personId);
        const body = html`<h1>${c.name}</h1><p class="muted">${c.kind} ${c.target}</p>
<form method="post"><input type="hidden" name="csrf" value="${session.csrf}"><input type="password" name="secret" aria-label="Secret" autocomplete="off" required maxlength="8000"> <button>Save</button></form>`;
        return res.type("html").send(layout({ title: "BE Botter", body }));
      }
      if (req.method !== "POST") return page(res, 405, "Not allowed.");
      const form = (req.body ?? {}) as Record<string, unknown>;
      if (!csrfOk(session, form)) return page(res, 403, "Not allowed.");
      await useSecretLink(db, secretsKey, hash, session.personId, typeof form.secret === "string" ? form.secret : "");
      page(res, 200, "Saved. Tell the bot it's done.");
    }),
  );

  return router;
}
