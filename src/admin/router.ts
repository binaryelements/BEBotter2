import express from "express";
import type { NextFunction, Request, Response, Router } from "express";
import { eq } from "drizzle-orm";
import { tenants } from "../db/schema.js";
import { ConnectionError } from "../connections/store.js";
import { KnowledgeError } from "../knowledge/store.js";
import { DirectoryError } from "../org/directory.js";
import type { FetchUsers } from "../org/directory-sync.js";
import { isAdmin, loadActor, mayEnter } from "./access.js";
import { activityRoutes } from "./activity.js";
import { assignmentRoutes } from "./assignments.js";
import type { MailDeps } from "../mail/mailboxes.js";
import { botRoutes } from "./bots.js";
import { adminOf, wrap } from "./http.js";
import { assetsDir, shell, themeOf, themes } from "./html.js";
import { knowledgeRoutes } from "./knowledge.js";
import { oidcRoutes, page } from "./oidc.js";
import type { OidcDeps } from "./oidc.js";
import { peopleRoutes } from "./people.js";
import { secretRoutes } from "./secret.js";
import { settingsRoutes } from "./settings.js";
import { csrfOk, readSession, sessionKey } from "./session.js";

export type AdminDeps = OidcDeps & { botName: string; defaultModel: string; fetchUsers: FetchUsers; onBotSaved?: (definitionId: string) => void; mail?: MailDeps };

export function adminRouter(deps: AdminDeps): Router {
  const { db } = deps;
  const sKey = sessionKey(deps.config.secretsKey);
  const router = express.Router();

  // Outside the no-store rule below: static, cacheable (the ?v= in the links busts it), and open to signed-out pages.
  router.use("/assets", express.static(assetsDir, { maxAge: "1y", immutable: true, index: false }));
  // Sets the theme cookie (dark, light, or device = forget it) and returns to the page; needs no script.
  router.get("/theme", (req, res) => {
    const set = String(req.query.set);
    const next = String(req.query.next);
    const value = themes.find((t) => t === set);
    res.append("Set-Cookie", `theme=${value ?? ""}; Path=/admin; SameSite=Lax; Max-Age=${value ? 31536000 : 0}`);
    res.redirect(303, /^\/admin(\/[\w./-]*)?$/.test(next) ? next : "/admin");
  });

  // Body parsing resumes on the socket's async context, so the shell facts are set again after it.
  const withShell = (req: Request, _res: Response, next: NextFunction) =>
    shell.run({ theme: themeOf(req.headers.cookie), path: req.originalUrl.split("?")[0] }, next);

  router.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Content-Security-Policy": "frame-ancestors 'none'", "Referrer-Policy": "no-referrer" });
    withShell(req, res, next);
  });
  router.use(oidcRoutes(deps));
  router.use(express.urlencoded({ extended: false }));
  router.use(withShell);
  // before the admin guard: any signed-in person of the tenant may open their own secret link
  router.use(secretRoutes(db, deps.config.secretsKey));

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
      const store = shell.getStore();
      if (store) store.company = (await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, actor.tenantId)))[0]?.name;
      next();
    }),
  );

  router.get("/", (_req, res) => res.redirect(303, isAdmin(adminOf(res).actor) ? "/admin/people" : "/admin/departments"));
  router.use(peopleRoutes(db, deps.fetchUsers));
  router.use(botRoutes({ db, secretsKey: deps.config.secretsKey, defaultModel: deps.defaultModel, onSaved: deps.onBotSaved, mail: deps.mail }));
  router.use(assignmentRoutes(db));
  router.use(activityRoutes(db));
  router.use(knowledgeRoutes(db, deps.config.secretsKey));
  router.use(settingsRoutes(db));

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // Body-parser errors (too large, malformed) carry a 4xx status and can arrive before sign-in.
    const status = (err as { status?: unknown } | null)?.status;
    if (typeof status === "number" && status < 500) return page(res, 400, "Bad request.");
    if (err instanceof DirectoryError || err instanceof KnowledgeError || err instanceof ConnectionError) return page(res, 400, err.message);
    console.error("admin request failed", err);
    page(res, 500, "Something went wrong.");
  });

  return router;
}
