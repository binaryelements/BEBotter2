import express from "express";
import type { NextFunction, Request, Response, Router } from "express";
import { DirectoryError } from "../org/directory.js";
import { isAdmin, loadActor, mayEnter } from "./access.js";
import { assignmentRoutes } from "./assignments.js";
import { botRoutes } from "./bots.js";
import { adminOf, wrap } from "./http.js";
import { oidcRoutes, page } from "./oidc.js";
import type { OidcDeps } from "./oidc.js";
import { peopleRoutes } from "./people.js";
import { csrfOk, readSession, sessionKey } from "./session.js";

export type AdminDeps = OidcDeps & { botName: string; defaultModel: string };

export function adminRouter(deps: AdminDeps): Router {
  const { db } = deps;
  const sKey = sessionKey(deps.config.secretsKey);
  const router = express.Router();

  router.use(oidcRoutes(deps));
  router.use(express.urlencoded({ extended: false }));

  // Everything mounted after this guard requires a signed-in admin or head.
  router.use(
    wrap(async (req, res, next) => {
      const safe = req.method === "GET" || req.method === "HEAD";
      const session = readSession(sKey, req.headers.cookie);
      if (!session) return safe ? res.redirect(303, "/admin/auth/login") : page(res, 403, "Not allowed.");
      const actor = await loadActor(db, session.tenantId, session.personId);
      if (!actor || !mayEnter(actor)) return page(res, 403, "You do not have access to the admin page.");
      if (!safe && !csrfOk(session, (req.body ?? {}) as Record<string, unknown>)) return page(res, 403, "Not allowed.");
      res.locals.admin = { actor, csrf: session.csrf };
      next();
    }),
  );

  router.get("/", (_req, res) => res.redirect(303, isAdmin(adminOf(res).actor) ? "/admin/people" : "/admin/departments"));
  router.use(peopleRoutes(db));
  router.use(botRoutes({ db, secretsKey: deps.config.secretsKey, defaultModel: deps.defaultModel }));
  router.use(assignmentRoutes(db));

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof DirectoryError) return page(res, 400, err.message);
    console.error("admin request failed", err);
    page(res, 500, "Something went wrong.");
  });

  return router;
}
