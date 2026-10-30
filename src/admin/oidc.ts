import { createHash, randomBytes } from "node:crypto";
import express from "express";
import type { Response, Router } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Db } from "../db/client.js";
import type { Config } from "../config/config.js";
import { setAdminFromEmail } from "../org/directory.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { loadActor, mayEnter } from "./access.js";
import { html, layout } from "./html.js";
import { LOGIN_COOKIE, SESSION_COOKIE, cookie, csrfOk, loginKey, parseCookies, readSession, readToken, sameSecret, sessionKey, signSession, signToken } from "./session.js";

export type IdClaims = { oid: string; tid: string; name: string; email: string };
export type OidcDeps = {
  db: Db;
  config: Pick<Config, "teams" | "publicUrl" | "adminEmails" | "secretsKey">;
  exchangeCode: (code: string, verifier: string, redirectUri: string) => Promise<{ id_token: string }>;
  verifyIdToken: (idToken: string, nonce: string) => Promise<IdClaims>;
};

const SESSION_SECONDS = 8 * 3600;
const LOGIN_SECONDS = 10 * 60;
const authority = (tid: string) => `https://login.microsoftonline.com/${encodeURIComponent(tid)}`;
const random = () => randomBytes(32).toString("base64url");
/** Only plain paths under /admin/ may be returned to after sign-in, so the redirect cannot leave the site. */
const safeReturn = (v: unknown): v is string => typeof v === "string" && /^\/admin(\/[A-Za-z0-9_-]+)+$/.test(v);

export function page(res: Response, status: number, message: string) {
  res.status(status).type("html").send(layout({ title: "BE Botter admin", body: html`<p>${message}</p>` }));
}

export function oidcRoutes(deps: OidcDeps): Router {
  const { db, config } = deps;
  const sKey = sessionKey(config.secretsKey);
  const lKey = loginKey(config.secretsKey);
  const redirectUri = `${config.publicUrl}/admin/auth/callback`;
  const router = express.Router();

  router.get("/auth/login", (req, res) => {
    const state = random(), nonce = random(), verifier = random();
    const returnTo = safeReturn(req.query.returnTo) ? { returnTo: req.query.returnTo } : {};
    res.append("Set-Cookie", cookie(LOGIN_COOKIE, signToken(lKey, { state, nonce, verifier, ...returnTo, exp: Date.now() + LOGIN_SECONDS * 1000 }), LOGIN_SECONDS));
    const query = new URLSearchParams({
      client_id: config.teams.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      response_mode: "query",
      scope: "openid profile email",
      state,
      nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    res.redirect(302, `${authority(config.teams.tenantId)}/oauth2/v2.0/authorize?${query}`);
  });

  router.get("/auth/callback", async (req, res) => {
    try {
      // The login state is single-use: drop it whatever happens next.
      res.append("Set-Cookie", cookie(LOGIN_COOKIE, "", 0));
      const login = readToken(lKey, parseCookies(req.headers.cookie).get(LOGIN_COOKIE));
      const { state, code } = req.query;
      if (
        !login ||
        typeof login.state !== "string" || typeof login.nonce !== "string" || typeof login.verifier !== "string" ||
        typeof state !== "string" || typeof code !== "string" || !code ||
        !sameSecret(state, login.state)
      )
        return page(res, 400, "Sign-in expired or was interrupted. Start again.");

      let claims: IdClaims;
      try {
        const { id_token } = await deps.exchangeCode(code, login.verifier, redirectUri);
        claims = await deps.verifyIdToken(id_token, login.nonce);
      } catch {
        return page(res, 400, "Sign-in failed. Start again.");
      }
      if (claims.tid !== config.teams.tenantId) return page(res, 403, "This account belongs to another organization.");

      await upsertTenant(db, { id: claims.tid });
      const person = await upsertPerson(db, { tenantId: claims.tid, aadObjectId: claims.oid, name: claims.name });
      await setAdminFromEmail(db, claims.tid, person.id, claims.email, config.adminEmails);
      const actor = await loadActor(db, claims.tid, person.id);
      const back = safeReturn(login.returnTo) ? login.returnTo : "/admin";
      // anyone in the tenant may sign in to open their own secret link; the admin guard still refuses them everywhere else
      if (!actor || (!mayEnter(actor) && !back.startsWith("/admin/secret/"))) return page(res, 403, "You do not have access to the admin page.");

      const session = { personId: person.id, tenantId: claims.tid, csrf: random(), exp: Date.now() + SESSION_SECONDS * 1000 };
      res.append("Set-Cookie", cookie(SESSION_COOKIE, signSession(sKey, session), SESSION_SECONDS));
      res.redirect(303, back);
    } catch (e) {
      // Answered here so no stack trace ever reaches the browser.
      console.error("admin sign-in failed", e);
      page(res, 500, "Sign-in failed. Start again.");
    }
  });

  router.post("/auth/logout", express.urlencoded({ extended: false }), (req, res) => {
    const session = readSession(sKey, req.headers.cookie);
    if (!session || !csrfOk(session, (req.body ?? {}) as Record<string, unknown>)) return page(res, 403, "Not allowed.");
    res.append("Set-Cookie", cookie(SESSION_COOKIE, "", 0));
    res.redirect(303, "/admin/auth/login");
  });

  return router;
}

/** Production wiring; Entra's endpoints are only reached here. */
export function realOidcDeps(config: OidcDeps["config"], db: Db): OidcDeps {
  const { tenantId, clientId, clientSecret } = config.teams;
  const base = authority(tenantId);
  const jwks = createRemoteJWKSet(new URL(`${base}/discovery/v2.0/keys`));
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    db,
    config,
    exchangeCode: async (code, verifier, redirectUri) => {
      const res = await fetch(`${base}/oauth2/v2.0/token`, {
        method: "POST",
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: "authorization_code" }),
      });
      if (!res.ok) throw new Error(`Token endpoint answered ${res.status}`);
      const body = (await res.json()) as { id_token?: unknown };
      if (typeof body.id_token !== "string") throw new Error("Token endpoint returned no id_token");
      return { id_token: body.id_token };
    },
    verifyIdToken: async (idToken, nonce) => {
      const { payload } = await jwtVerify(idToken, jwks, { issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`, audience: clientId, algorithms: ["RS256"], requiredClaims: ["exp", "iat"] });
      if (typeof payload.nonce !== "string" || !sameSecret(payload.nonce, nonce)) throw new Error("ID token nonce mismatch");
      const oid = str(payload.oid), tid = str(payload.tid);
      if (!oid || !tid) throw new Error("ID token lacks oid or tid");
      return { oid, tid, name: str(payload.name) || oid, email: str(payload.email) || str(payload.preferred_username) };
    },
  };
}
