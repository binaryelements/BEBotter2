import express from "express";
import type { NextFunction, Request, Response, Router } from "express";
import { eq } from "drizzle-orm";
import { tenants } from "../db/schema.js";
import { ConnectionError } from "../connections/store.js";
import type { SqlRunner } from "../connections/sql.js";
import type { SshRunner } from "../connections/ssh.js";
import type { Engine } from "../engine/engine.js";
import { KnowledgeError } from "../knowledge/store.js";
import { DirectoryError } from "../org/directory.js";
import type { FetchUsers } from "../org/directory-sync.js";
import { isAdmin, loadActor, mayEnter } from "./access.js";
import { activityRoutes } from "./activity.js";
import { assignmentRoutes } from "./assignments.js";
import type { MailDeps } from "../mail/mailboxes.js";
import { botRoutes } from "./bots.js";
import { adminOf, wrap } from "./http.js";
import { assetsDir, html, layout, shell, themeOf, themes } from "./html.js";
import { knowledgeRoutes } from "./knowledge.js";
import { oidcRoutes, page } from "./oidc.js";
import type { OidcDeps } from "./oidc.js";
import { overviewRoutes } from "./overview.js";
import { peopleRoutes } from "./people.js";
import { runbookRoutes } from "./runbooks.js";
import { secretRoutes } from "./secret.js";
import { settingsRoutes } from "./settings.js";
import { csrfOk, readSession, sessionKey } from "./session.js";
import { tryRoutes } from "./try.js";
import type { TryDeps } from "./try.js";

export type AdminDeps = OidcDeps & { botName: string; defaultModel: string; models?: string[]; engine?: Engine; fetchUsers: FetchUsers; onBotSaved?: (definitionId: string) => void; mail?: MailDeps; fetchFn?: typeof fetch; ssh?: SshRunner; sql?: SqlRunner } & TryDeps;

export function adminRouter(deps: AdminDeps): Router {
  const { db } = deps;
  const sKey = sessionKey(deps.config.secretsKey);
  const router = express.Router();
  const FLASH = "bb_flash";
  const flashCookie = (kind: "good" | "bad", text: string) =>
    `${FLASH}=${encodeURIComponent(`${kind}:${text.slice(0, 300)}`)}; Path=/admin; SameSite=Lax; HttpOnly; Max-Age=30`;
  const readFlash = (cookieHeader: string | undefined): { kind: "good" | "bad"; text: string } | undefined => {
    const raw = /(?:^|;\s*)bb_flash=([^;]*)/.exec(cookieHeader ?? "")?.[1];
    if (!raw) return undefined;
    let value = "";
    try {
      value = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    const i = value.indexOf(":");
    if (i < 0) return undefined;
    return { kind: value.slice(0, i) === "bad" ? "bad" : "good", text: value.slice(i + 1) };
  };

  // Outside the no-store rule below: static, cacheable (the ?v= in the links busts it), and open to signed-out pages.
  router.use("/assets", express.static(assetsDir, { maxAge: "1y", immutable: true, index: false }));
  // Sets the theme cookie (dark, light, or device = forget it) and returns to the page; needs no script.
  router.get("/theme", (req, res) => {
    const set = String(req.query.set);
    const next = String(req.query.next);
    const value = themes.find((t) => t === set);
    res.append("Set-Cookie", `theme=${value ?? ""}; Path=/admin; SameSite=Lax; Max-Age=${value ? 31536000 : 0}`);
    // path segments without dots, so "/admin/../x" never passes
    res.redirect(303, /^\/admin(\/[\w-]+)*\/?(\?[\w./%=&-]*)?$/.test(next) ? next : "/admin");
  });

  // Body parsing resumes on the socket's async context, so the shell facts are set again after it.
  const withShell = (req: Request, res: Response, next: NextFunction) =>
    shell.run({ theme: themeOf(req.headers.cookie), path: req.originalUrl.split("?")[0], url: req.originalUrl, flash: res.locals.flash }, next);

  router.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Content-Security-Policy": "frame-ancestors 'none'", "Referrer-Policy": "no-referrer" });
    // a one-shot flash from the previous POST: show it once, then clear the cookie
    const flash = readFlash(req.headers.cookie);
    if (flash) {
      res.locals.flash = flash;
      res.append("Set-Cookie", `${FLASH}=; Path=/admin; SameSite=Lax; HttpOnly; Max-Age=0`);
    }
    // every POST that lands back on an admin page says it saved; a failed POST says why instead
    if (req.method === "POST") {
      const redirect = res.redirect.bind(res) as (status: number, url: string) => void;
      res.redirect = ((status: number | string, url?: string) => {
        const [code, to] = typeof status === "number" ? [status, url!] : [302, status];
        const skip = res.locals.noFlash === true || to === "/admin/sign-in" || to.startsWith("/admin/auth/") || to.startsWith("/admin/theme") || to.includes("synced=");
        if (!skip && to.startsWith("/admin")) res.append("Set-Cookie", flashCookie("good", "saved"));
        redirect(code, to);
      }) as typeof res.redirect;
    }
    withShell(req, res, next);
  });
  router.use(oidcRoutes(deps));
  // a page of our own before Microsoft's: a bare redirect to a Microsoft login reads as phishing to browsers' safety checks
  router.get("/sign-in", (_req, res) => {
    res.type("html").send(
      layout({
        title: "Sign in · BE Teammate",
        body: html`<div class="be-card signin"><h1>Sign in</h1><p>The admin site for BE Teammate, Binary Elements' bots in Microsoft Teams.</p><p><a class="be-btn primary" href="/admin/auth/login">sign in with Microsoft</a></p></div>`,
      }),
    );
  });
  router.use(express.urlencoded({ extended: false }));
  router.use(withShell);
  // before the admin guard: any signed-in person of the tenant may open their own secret link
  router.use(secretRoutes(db, deps.config.secretsKey));

  // Everything mounted after this guard requires a signed-in admin or head.
  router.use(
    wrap(async (req, res, next) => {
      const safe = req.method === "GET" || req.method === "HEAD";
      const session = readSession(sKey, req.headers.cookie);
      if (!session) return safe ? res.redirect(303, "/admin/sign-in") : page(res, 403, "Not allowed.");
      const actor = await loadActor(db, session.tenantId, session.personId);
      if (!actor || !mayEnter(actor)) return page(res, 403, "You do not have access to the admin page.");
      if (!safe && !csrfOk(session, (req.body ?? {}) as Record<string, unknown>)) return page(res, 403, "Not allowed.");
      res.locals.admin = { actor, csrf: session.csrf };
      const store = shell.getStore();
      if (store) store.company = (await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, actor.tenantId)))[0]?.name;
      next();
    }),
  );

  router.use(overviewRoutes(db));
  router.use(peopleRoutes(db, deps.fetchUsers));
  router.use(botRoutes({ db, secretsKey: deps.config.secretsKey, publicUrl: deps.config.publicUrl, defaultModel: deps.defaultModel, models: deps.models, onSaved: deps.onBotSaved, mail: deps.mail, fetchFn: deps.fetchFn, ssh: deps.ssh, sql: deps.sql }));
  router.use(tryRoutes({ db, runTurn: deps.runTurn, confirmations: deps.confirmations }));
  router.use(assignmentRoutes(db));
  router.use(activityRoutes(db));
  router.use(knowledgeRoutes(db, deps.config.secretsKey));
  router.use(runbookRoutes({ db, key: deps.config.secretsKey, defaultModel: deps.defaultModel, models: deps.models, engine: deps.engine }));
  router.use(settingsRoutes(db, deps.models));

  router.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    // Body-parser errors (too large, malformed) carry a 4xx status and can arrive before sign-in.
    const status = (err as { status?: unknown } | null)?.status;
    const message =
      typeof status === "number" && status < 500
        ? "Bad request."
        : err instanceof DirectoryError || err instanceof KnowledgeError || err instanceof ConnectionError
          ? err.message
          : "Something went wrong.";
    if (!(err instanceof DirectoryError || err instanceof KnowledgeError || err instanceof ConnectionError) && !(typeof status === "number" && status < 500)) {
      console.error("admin request failed", err);
    }
    // a failed POST goes back to the page it came from with the reason as a toast
    const back = req.get("referer");
    if (req.method === "POST" && back) {
      try {
        const u = new URL(back);
        if (u.origin === `${req.protocol}://${req.get("host")}` && u.pathname.startsWith("/admin")) {
          res.locals.noFlash = true;
          res.append("Set-Cookie", flashCookie("bad", message));
          return res.redirect(303, u.pathname + u.search);
        }
      } catch {
        // a malformed referer falls through to the page below
      }
    }
    const domain = err instanceof DirectoryError || err instanceof KnowledgeError || err instanceof ConnectionError;
    const code = typeof status === "number" && status < 500 ? 400 : domain ? 400 : 500;
    page(res, code, message);
  });

  return router;
}
