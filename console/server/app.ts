import { join } from "node:path";
import express from "express";
import { and, desc, eq } from "drizzle-orm";
import { isAdmin, loadActor, mayEnter, type Actor } from "../../src/admin/access.js";
import { readSession, sameSecret, sessionKey, type Session } from "../../src/admin/session.js";
import type { Db } from "../../src/db/client.js";
import { auditEvents, tenants } from "../../src/db/schema.js";

/**
 * The admin console: the JSON API and the built React pages, as its own process.
 * It shares the database and the sign-in cookie with the engine and nothing else, so it deploys without restarting the bots.
 */
export type ConsoleDeps = { db: Db; secretsKey: Buffer; uiDir?: string; pollMs?: number };

type Locals = { actor: Actor; session: Session };
const localsOf = (res: express.Response) => res.locals as Locals;
const wrap =
  (fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>): express.RequestHandler =>
  (req, res, next) =>
    void fn(req, res, next).catch(next);

/** What the bell shows: approvals still waiting (10 min) and failures of the last day. Same rule as the old pages (src/admin/router.ts). */
export async function notifications(db: Db, actor: Actor, now = Date.now()) {
  if (!isAdmin(actor)) return { approvals: 0, failures: 0, items: [] };
  // read here rather than through src/audit: that module pulls the Teams and engine code into this process
  const latest = (status: string) =>
    db
      .select({ id: auditEvents.id, kind: auditEvents.kind, summary: auditEvents.summary, startedAt: auditEvents.startedAt })
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, actor.tenantId), eq(auditEvents.status, status)))
      .orderBy(desc(auditEvents.startedAt))
      .limit(5);
  const [pending, failed] = await Promise.all([latest("pending"), latest("failed")]);
  const approvals = pending.filter((r) => r.kind === "tool" && r.startedAt.getTime() > now - 10 * 60_000);
  const failures = failed.filter((r) => r.startedAt.getTime() > now - 24 * 60 * 60_000);
  const item = (kind: "approval" | "failure") => (r: (typeof pending)[number]) => ({
    id: r.id,
    kind,
    title: r.summary,
    at: r.startedAt.toISOString(),
    href: `/admin/activity?status=${kind === "approval" ? "pending" : "failed"}`,
  });
  return { approvals: approvals.length, failures: failures.length, items: [...approvals.map(item("approval")), ...failures.map(item("failure"))].slice(0, 6) };
}

function api({ db, secretsKey, pollMs = 5000 }: ConsoleDeps): express.Router {
  const key = sessionKey(secretsKey);
  const r = express.Router();
  r.use(express.json());
  r.use(
    wrap(async (req, res, next) => {
      res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      const session = readSession(key, req.headers.cookie);
      if (!session) return res.status(401).json({ error: "signed out" });
      const actor = await loadActor(db, session.tenantId, session.personId);
      if (!actor || !mayEnter(actor)) return res.status(403).json({ error: "no access" });
      // a cookie alone never changes anything: the page must also send the session's token
      if (!["GET", "HEAD"].includes(req.method) && !sameSecret(String(req.get("x-csrf") ?? ""), session.csrf)) return res.status(403).json({ error: "bad csrf" });
      Object.assign(res.locals, { actor, session });
      next();
    }),
  );

  r.get(
    "/me",
    wrap(async (_req, res) => {
      const { actor, session } = localsOf(res);
      const [tenant] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, actor.tenantId));
      res.json({ name: actor.name, admin: isAdmin(actor), headOf: actor.headOf, company: tenant?.name ?? null, csrf: session.csrf });
    }),
  );

  r.get("/notifications", wrap(async (_req, res) => res.json(await notifications(db, localsOf(res).actor))));

  // One stream per open page: it says what changed, the page refetches or takes the payload.
  // shortcut: each stream polls the database every few seconds, switch to LISTEN/NOTIFY when many admins keep it open
  r.get("/events", (req, res) => {
    const { actor, session } = localsOf(res);
    res.set({ "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    let last = "";
    const tick = async () => {
      if (session.exp < Date.now()) return res.end();
      const data = JSON.stringify(await notifications(db, actor));
      res.write(data === last ? ":\n\n" : `event: notifications\ndata: ${data}\n\n`);
      last = data;
    };
    const fail = () => res.end();
    void tick().catch(fail);
    const timer = setInterval(() => void tick().catch(fail), pollMs);
    req.on("close", () => clearInterval(timer));
  });

  r.use((_req, res) => void res.status(404).json({ error: "not found" }));
  r.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("console api", err);
    if (!res.headersSent) res.status(500).json({ error: "something went wrong" });
  });
  return r;
}

export function consoleApp(deps: ConsoleDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  const r = express.Router();
  r.get("/health", (_req, res) => void res.json({ ok: true }));
  r.use("/api", api(deps));
  const { uiDir } = deps;
  if (uiDir) {
    // built files carry a content hash in their name; the page itself is always fetched fresh
    r.use("/assets", express.static(join(uiDir, "assets"), { immutable: true, maxAge: "1y", fallthrough: false }));
    r.use(express.static(uiDir, { index: false }));
    r.get("*", (_req, res) => {
      res.set({ "Cache-Control": "no-store", "Content-Security-Policy": "frame-ancestors 'none'", "Referrer-Policy": "no-referrer" });
      res.sendFile(join(uiDir, "index.html"));
    });
  }
  // the proxy may or may not strip the path prefix; both work
  app.use("/admin/console", r);
  app.use("/", r);
  return app;
}
