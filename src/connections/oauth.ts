import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { connections } from "../db/schema.js";
import type { Connection } from "../db/schema.js";
import { decrypt, encrypt } from "../secrets/cipher.js";

/** An MCP server that signs BE Teammate in as an OAuth client (MCP authorization: RFC 9728 discovery, RFC 7591 registration, PKCE). */
export type OAuthConfig = { clientId: string; authorizationEndpoint: string; tokenEndpoint: string; scope?: string };
/** What the connection's secret holds once signed in; `expiresAt` 0 means the server gave no lifetime. */
type Tokens = { access: string; refresh?: string; expiresAt: number; clientSecret?: string };
type Deps = { db: Db; secretsKey: Buffer; fetchFn: typeof fetch };

export class OAuthError extends Error {}
const fail = (message: string): never => {
  throw new OAuthError(message);
};
const TIMEOUT_MS = 10_000;
const SIGN_IN_TTL_MS = 10 * 60_000;

export const oauthOf = (c: Pick<Connection, "kind" | "config">): OAuthConfig | undefined => (c.kind === "mcp" ? (c.config as { oauth?: OAuthConfig }).oauth : undefined);

async function getJson(fetchFn: typeof fetch, url: string, init?: RequestInit): Promise<Record<string, unknown> | undefined> {
  const r = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => undefined);
  if (!r?.ok) return undefined;
  return (await r.json().catch(() => undefined)) as Record<string, unknown> | undefined;
}
const wellKnown = (issuer: string, name: string) => {
  const u = new URL(issuer);
  return `${u.origin}/.well-known/${name}${u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "")}`;
};

/** Finds the server's login and registers BE Teammate there: protected-resource metadata names the authorization server, else the server's own origin is tried. */
export async function discover(fetchFn: typeof fetch, mcpUrl: string, redirectUri: string): Promise<OAuthConfig & { clientSecret?: string }> {
  const resource = (await getJson(fetchFn, wellKnown(mcpUrl, "oauth-protected-resource"))) ?? (await getJson(fetchFn, wellKnown(new URL(mcpUrl).origin, "oauth-protected-resource")));
  const issuers = Array.isArray(resource?.authorization_servers) && resource.authorization_servers.length ? (resource.authorization_servers as string[]) : [new URL(mcpUrl).origin];
  let meta: Record<string, unknown> | undefined;
  for (const issuer of issuers) {
    meta = (await getJson(fetchFn, wellKnown(issuer, "oauth-authorization-server"))) ?? (await getJson(fetchFn, `${new URL(issuer).origin}/.well-known/openid-configuration`));
    if (typeof meta?.authorization_endpoint === "string" && typeof meta?.token_endpoint === "string") break;
    meta = undefined;
  }
  if (!meta) fail("The server did not say where to sign in: no OAuth metadata was found");
  if (typeof meta!.registration_endpoint !== "string") fail("The server does not register clients, so BE Teammate can't sign in to it");
  const reg = await getJson(fetchFn, meta!.registration_endpoint as string, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "BE Teammate", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  });
  if (typeof reg?.client_id !== "string") fail("The server refused to register BE Teammate as a client");
  const scopes = resource?.scopes_supported;
  return {
    clientId: reg!.client_id as string,
    authorizationEndpoint: meta!.authorization_endpoint as string,
    tokenEndpoint: meta!.token_endpoint as string,
    ...(Array.isArray(scopes) && scopes.length ? { scope: scopes.join(" ") } : {}),
    ...(typeof reg!.client_secret === "string" ? { clientSecret: reg!.client_secret } : {}),
  };
}

// shortcut: sign-ins in progress live in memory, so one runs on one instance only; move them to the database if the app is ever run twice
const pending = new Map<string, { tenantId: string; connectionId: string; verifier: string; redirectUri: string; at: number }>();
const b64url = (b: Buffer) => b.toString("base64url");

/** The URL to send the person to; the state remembers the connection for ten minutes. */
export function beginSignIn(c: Connection, redirectUri: string): string {
  const oauth = oauthOf(c) ?? fail(`${c.name} is not an OAuth connection`);
  for (const [k, v] of pending) if (Date.now() - v.at > SIGN_IN_TTL_MS) pending.delete(k);
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(16));
  pending.set(state, { tenantId: c.tenantId, connectionId: c.id, verifier, redirectUri, at: Date.now() });
  const u = new URL(oauth.authorizationEndpoint);
  const params = { response_type: "code", client_id: oauth.clientId, redirect_uri: redirectUri, code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", state, resource: c.target, ...(oauth.scope ? { scope: oauth.scope } : {}) };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

async function tokenRequest(fetchFn: typeof fetch, oauth: OAuthConfig, resource: string, params: Record<string, string>, clientSecret?: string): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({ client_id: oauth.clientId, resource, ...params, ...(clientSecret ? { client_secret: clientSecret } : {}) });
  const r = await fetchFn(oauth.tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: body.toString(), signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => undefined);
  if (!r) fail("The sign-in server did not answer");
  const json = (await r!.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r!.ok || typeof json.access_token !== "string") fail(`The sign-in server refused: ${typeof json.error === "string" ? json.error : r!.status}`);
  return json;
}
const toTokens = (json: Record<string, unknown>, previous?: Tokens): Tokens => ({
  access: json.access_token as string,
  ...(typeof json.refresh_token === "string" ? { refresh: json.refresh_token } : previous?.refresh ? { refresh: previous.refresh } : {}),
  expiresAt: typeof json.expires_in === "number" ? Date.now() + json.expires_in * 1000 : 0,
  ...(previous?.clientSecret ? { clientSecret: previous.clientSecret } : {}),
});
const tokensOf = (deps: Pick<Deps, "secretsKey">, c: Connection): Tokens | undefined => (c.secretCipher ? (JSON.parse(decrypt(deps.secretsKey, c.secretCipher)) as Tokens) : undefined);
const saveTokens = (deps: Deps, c: Connection, t: Tokens) =>
  deps.db.update(connections).set({ secretCipher: encrypt(deps.secretsKey, JSON.stringify(t)), status: "active", updatedAt: new Date() }).where(and(eq(connections.id, c.id), eq(connections.tenantId, c.tenantId)));

/** Swaps the code for tokens, stores them encrypted, and the connection goes active. */
export async function finishSignIn(deps: Deps, tenantId: string, state: string, code: string): Promise<Connection> {
  const p = pending.get(state);
  if (!p || p.tenantId !== tenantId || Date.now() - p.at > SIGN_IN_TTL_MS) fail("The sign-in took too long or was already used; start it again");
  pending.delete(state); // one-time: the code it carries must not be exchanged twice
  const [c] = await deps.db.select().from(connections).where(and(eq(connections.id, p!.connectionId), eq(connections.tenantId, tenantId)));
  const oauth = (c && oauthOf(c)) ?? fail("The connection is gone");
  const previous = tokensOf(deps, c!); // a client secret from registration is kept across sign-ins; old tokens are not
  const tokens = toTokens(await tokenRequest(deps.fetchFn, oauth, c!.target, { grant_type: "authorization_code", code, redirect_uri: p!.redirectUri, code_verifier: p!.verifier }, previous?.clientSecret), previous && { ...previous, refresh: undefined });
  await saveTokens(deps, c!, tokens);
  return (await deps.db.select().from(connections).where(eq(connections.id, c!.id)))[0]!;
}

/** Keeps a registration's client secret with the connection before any sign-in. */
export const clientSecretCipher = (secretsKey: Buffer, clientSecret: string) => encrypt(secretsKey, JSON.stringify({ access: "", expiresAt: 0, clientSecret } satisfies Tokens));

/** A usable access token, refreshed within a minute of expiry; a refresh the server refuses puts the connection back to pending (sign in again). */
export async function accessToken(deps: Deps, c: Connection): Promise<string> {
  const oauth = oauthOf(c) ?? fail(`${c.name} is not an OAuth connection`);
  const t = tokensOf(deps, c);
  if (!t?.access) fail(`${c.name} needs a sign-in`);
  if (!t!.expiresAt || t!.expiresAt - Date.now() > 60_000) return t!.access;
  const back = () => deps.db.update(connections).set({ status: "pending", updatedAt: new Date() }).where(eq(connections.id, c.id));
  if (!t!.refresh) {
    await back();
    fail(`${c.name}'s sign-in has expired; sign in again`);
  }
  try {
    const next = toTokens(await tokenRequest(deps.fetchFn, oauth, c.target, { grant_type: "refresh_token", refresh_token: t!.refresh! }, t!.clientSecret), t);
    await saveTokens(deps, c, next);
    return next.access;
  } catch (e) {
    await back();
    throw e;
  }
}
