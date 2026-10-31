import { createHash } from "node:crypto";
import express from "express";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDb } from "../db/test-db.js";
import type { Db } from "../db/client.js";
import { people } from "../db/schema.js";
import { oidcRoutes } from "./oidc.js";
import type { OidcDeps } from "./oidc.js";
import { loginKey, readSession, sessionKey, signSession, signToken } from "./session.js";
import { serve } from "./test-server.js";

type Claims = { oid: string; tid: string; name: string; email: string };
const secretsKey = Buffer.alloc(32, 7);
const config = {
  teams: { clientId: "client-1", tenantId: "tenant-1", clientSecret: "s" },
  publicUrl: "https://bot.example.test",
  adminEmails: ["boss@example.test"],
  secretsKey,
};
const tokens: Record<string, Claims> = {
  "code-admin": { oid: "o-admin", tid: "tenant-1", name: "Boss", email: "Boss@example.test" },
  "code-user": { oid: "o-user", tid: "tenant-1", name: "Pat", email: "pat@example.test" },
  "code-foreign": { oid: "o-x", tid: "tenant-2", name: "X", email: "boss@example.test" },
};

describe("oidc", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  const exchanged: { code: string; verifier: string; redirectUri: string }[] = [];
  const verified: { idToken: string; nonce: string }[] = [];
  const used = new Set<string>();

  beforeAll(async () => {
    db = await testDb();
    const deps: OidcDeps = {
      db,
      config,
      exchangeCode: async (code, verifier, redirectUri) => {
        if (used.has(code) || !tokens[code]) throw new Error("invalid_grant"); // the real endpoint redeems a code once
        used.add(code);
        exchanged.push({ code, verifier, redirectUri });
        return { id_token: `id-${code}` };
      },
      verifyIdToken: async (idToken, nonce) => {
        verified.push({ idToken, nonce });
        return tokens[idToken.slice(3)];
      },
    };
    const app = express();
    app.use("/admin", oidcRoutes(deps));
    ({ url, close } = await serve(app));
  });
  afterAll(() => close());

  const get = (path: string, cookie?: string) => fetch(url + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
  const setCookie = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  const value = (c: string | undefined) => c?.split(";")[0].slice(c.indexOf("=") + 1) ?? "";

  async function login() {
    const res = await get("/admin/auth/login");
    const c = setCookie(res, "bb_login")!;
    const location = new URL(res.headers.get("location")!);
    return { res, cookie: c, token: value(c), location, state: location.searchParams.get("state")! };
  }
  const callback = (code: string, state: string, cookie?: string) =>
    get(`/admin/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, cookie);

  it("login redirects to the Entra authorize URL with PKCE, state and nonce", async () => {
    const { res, cookie, token, location } = await login();
    expect(res.status).toBe(302);
    expect(location.origin + location.pathname).toBe("https://login.microsoftonline.com/tenant-1/oauth2/v2.0/authorize");
    const q = location.searchParams;
    expect(q.get("client_id")).toBe("client-1");
    expect(q.get("response_type")).toBe("code");
    expect(q.get("scope")).toBe("openid profile email");
    expect(q.get("redirect_uri")).toBe("https://bot.example.test/admin/auth/callback");
    expect(q.get("code_challenge_method")).toBe("S256");
    const stored = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
    expect(q.get("code_challenge")).toBe(createHash("sha256").update(stored.verifier).digest("base64url"));
    expect(Buffer.from(stored.verifier, "base64url")).toHaveLength(32);
    expect(q.get("state")).toBe(stored.state);
    expect(q.get("nonce")).toBe(stored.nonce);
    expect(stored.exp - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/admin/);
    expect(cookie).toMatch(/Max-Age=600/);
  });

  it("callback with a wrong state or no login cookie is 400", async () => {
    const { cookie } = await login();
    expect((await callback("code-user", "wrong", `bb_login=${value(cookie)}`)).status).toBe(400);
    const { state } = await login();
    expect((await callback("code-user", state)).status).toBe(400);
    expect(exchanged.find((e) => e.code === "code-user")).toBeUndefined();
  });

  it("does not echo query parameters", async () => {
    const res = await get(`/admin/auth/callback?state=${encodeURIComponent("<script>x</script>")}&error=${encodeURIComponent("<b>e</b>")}`);
    const body = await res.text();
    expect(body).not.toContain("<script>x");
    expect(body).not.toContain("<b>e");
  });

  it("refuses a token from another tenant with 403", async () => {
    const { token, state } = await login();
    const res = await callback("code-foreign", state, `bb_login=${token}`);
    expect(res.status).toBe(403);
    expect(setCookie(res, "bb_session")).toBeUndefined();
    expect(await db.select().from(people).where(eq(people.aadObjectId, "o-x"))).toHaveLength(0);
  });

  it("an email listed in adminEmails becomes admin and gets a session", async () => {
    const { token, state } = await login();
    const stored = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
    const res = await callback("code-admin", state, `bb_login=${token}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin");
    expect(exchanged.at(-1)).toEqual({ code: "code-admin", verifier: stored.verifier, redirectUri: "https://bot.example.test/admin/auth/callback" });
    expect(verified.at(-1)).toEqual({ idToken: "id-code-admin", nonce: stored.nonce });
    const c = setCookie(res, "bb_session")!;
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/Secure/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).toMatch(/Path=\/admin/);
    expect(c).toMatch(/Max-Age=28800/);
    expect(setCookie(res, "bb_login")).toMatch(/Max-Age=0/);
    const [p] = await db.select().from(people).where(eq(people.aadObjectId, "o-admin"));
    expect(p).toMatchObject({ tenantId: "tenant-1", name: "Boss", role: "admin", email: "boss@example.test" });
    const s = readSession(sessionKey(secretsKey), `bb_session=${value(c)}`)!;
    expect(s).toMatchObject({ personId: p.id, tenantId: "tenant-1" });
    expect(Buffer.from(s.csrf, "base64url")).toHaveLength(32);
    expect(s.exp - Date.now()).toBeGreaterThan(8 * 3600_000 - 60_000);
  });

  it("a callback replayed with a used or forged state is refused", async () => {
    const { token, state } = await login();
    const first = await callback("code-admin", state, `bb_login=${token}`);
    expect(first.status).toBe(400); // code-admin was already redeemed above
    expect(setCookie(first, "bb_session")).toBeUndefined();

    const fresh = await login();
    // Replayed without the cleared login cookie, as a browser would after a callback.
    expect((await callback("code-user", fresh.state)).status).toBe(400);
    // A login cookie forged under another key with a chosen state.
    const forged = signToken(loginKey(Buffer.alloc(32, 9)), { state: "s", nonce: "n", verifier: "v", exp: Date.now() + 60_000 });
    expect((await callback("code-user", "s", `bb_login=${forged}`)).status).toBe(400);
    expect(exchanged.find((e) => e.code === "code-user")).toBeUndefined();
  });

  it("an ordinary user who heads no department is refused with no session cookie", async () => {
    const { token, state } = await login();
    const res = await callback("code-user", state, `bb_login=${token}`);
    expect(res.status).toBe(403);
    expect(setCookie(res, "bb_session")).toBeUndefined();
    expect(await res.text()).toContain("<html");
    const [p] = await db.select().from(people).where(eq(people.aadObjectId, "o-user"));
    expect(p).toMatchObject({ role: "user", email: "pat@example.test" });
  });

  it("does not accept the login cookie as a session or the session as a login cookie", async () => {
    const { token, state } = await login();
    expect(readSession(sessionKey(secretsKey), `bb_session=${token}`)).toBeUndefined();
    const session = signSession(sessionKey(secretsKey), { personId: "p", tenantId: "tenant-1", csrf: "c", exp: Date.now() + 60_000 });
    expect((await callback("code-user", state, `bb_login=${session}`)).status).toBe(400);
    const res = await fetch(`${url}/admin/auth/logout`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: `bb_session=${token}`, "content-type": "application/x-www-form-urlencoded" },
      body: "csrf=c",
    });
    expect(res.status).toBe(403);
  });

  describe("logout", () => {
    const session = () => signSession(sessionKey(secretsKey), { personId: "p", tenantId: "tenant-1", csrf: "tok", exp: Date.now() + 60_000 });
    const logout = (cookie: string, body: string) =>
      fetch(`${url}/admin/auth/logout`, { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body });

    it("clears the session with the right csrf", async () => {
      const res = await logout(`bb_session=${session()}`, "csrf=tok");
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/admin/auth/login");
      expect(setCookie(res, "bb_session")).toMatch(/Max-Age=0/);
    });

    it("refuses a wrong or missing csrf and a missing session", async () => {
      for (const res of [await logout(`bb_session=${session()}`, "csrf=nope"), await logout(`bb_session=${session()}`, ""), await logout("", "csrf=tok")]) {
        expect(res.status).toBe(403);
        expect(setCookie(res, "bb_session")).toBeUndefined();
      }
    });
  });

  it("answers a database failure with a plain 500 and no stack trace", async () => {
    const broken = new Proxy({}, { get: () => { throw new Error("db down"); } }) as Db;
    const app = express();
    app.use("/admin", oidcRoutes({ db: broken, config, exchangeCode: async () => ({ id_token: "id-code-admin" }), verifyIdToken: async () => tokens["code-admin"] }));
    const other = await serve(app);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const start = await fetch(`${other.url}/admin/auth/login`, { redirect: "manual" });
      const token = value(setCookie(start, "bb_login"));
      const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
      const res = await fetch(`${other.url}/admin/auth/callback?code=c&state=${state}`, { redirect: "manual", headers: { cookie: `bb_login=${token}` } });
      const body = await res.text();
      expect(res.status).toBe(500);
      expect(body).toContain("Sign-in failed. Start again.");
      expect(body).not.toMatch(/\bat /);
      expect(body).not.toContain("db down");
      expect(setCookie(res, "bb_session")).toBeUndefined();
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      await other.close();
    }
  });
});
