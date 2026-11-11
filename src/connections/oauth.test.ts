import { beforeEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { upsertDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { connections } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { decrypt, encrypt } from "../secrets/cipher.js";
import { fakeSsh } from "./ssh.js";
import { accessToken, assertPublicUrl, beginSignIn, discover, finishSignIn, LOOPBACK_REDIRECT } from "./oauth.js";
import { connectionMcpConfigs, createConnection, listConnections } from "./store.js";

const key = randomBytes(32);
const MCP = "https://mcp.example.test/s3";
const REDIRECT = "https://bot.example.test/admin/connections/oauth/callback";

/** A hosted MCP server the MCP authorization way: resource metadata, an authorization server with registration, PKCE-checked token requests. */
function fakeServer() {
  const calls: { url: string; body: string }[] = [];
  let issued = 0;
  let refuseRefresh = false;
  let stringExpiry = false;
  let loopbackOnly = false;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = String(init?.body ?? "");
    calls.push({ url, body });
    if (url === "https://mcp.example.test/.well-known/oauth-protected-resource/s3") return Response.json({ resource: MCP, authorization_servers: ["https://login.example.test/"], scopes_supported: ["s3:read", "s3:write"] });
    if (url === "https://login.example.test/.well-known/oauth-authorization-server")
      return Response.json({ authorization_endpoint: "https://login.example.test/authorize", token_endpoint: "https://login.example.test/token", registration_endpoint: "https://login.example.test/register" });
    if (url === "https://login.example.test/register") {
      const uris = JSON.parse(body).redirect_uris as string[];
      if (loopbackOnly && !uris[0]!.startsWith("http://127.0.0.1")) return Response.json({ error: "server_error" }, { status: 500 });
      return Response.json({ client_id: "client-1", redirect_uris: uris }, { status: 201 });
    }
    if (url === "https://login.example.test/token") {
      const p = new URLSearchParams(body);
      if (p.get("grant_type") === "authorization_code") {
        if (p.get("code") !== "code-1" || p.get("redirect_uri") !== (loopbackOnly ? LOOPBACK_REDIRECT : REDIRECT)) return Response.json({ error: "invalid_grant" }, { status: 400 });
        if (createHash("sha256").update(p.get("code_verifier")!).digest("base64url") !== fakeServer.challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
      } else if (p.get("grant_type") !== "refresh_token" || p.get("refresh_token") !== "refresh-1" || refuseRefresh) return Response.json({ error: "invalid_grant" }, { status: 400 });
      issued += 1;
      return Response.json({ access_token: `access-${issued}`, refresh_token: "refresh-1", expires_in: stringExpiry ? "3600" : 3600, token_type: "bearer" });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls, refuse: () => (refuseRefresh = true), loopbackOnly: () => (loopbackOnly = true), stringExpiry: () => (stringExpiry = true) };
}
fakeServer.challenge = "";

describe("mcp OAuth sign-in", () => {
  let db: Db;
  let defId: string;
  let personId: string;
  let server: ReturnType<typeof fakeServer>;
  let deps: { db: Db; secretsKey: Buffer; fetchFn: typeof fetch };
  beforeEach(async () => {
    db = await testDb();
    await upsertTenant(db, { id: "t1" });
    defId = (await upsertDefinition(db, key, "t1", { name: "ops", label: "Ops", persona: "p" })).id;
    personId = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "u1", name: "Ann" })).id;
    server = fakeServer();
    deps = { db, secretsKey: key, fetchFn: server.fetchFn };
  });
  const row = async () => (await db.select().from(connections).where(eq(connections.name, "wasabi")))[0]!;

  it("discovers the login through the resource metadata and registers as a client", async () => {
    const oauth = await discover(server.fetchFn, MCP, REDIRECT);
    expect(oauth).toEqual({ clientId: "client-1", authorizationEndpoint: "https://login.example.test/authorize", tokenEndpoint: "https://login.example.test/token", scope: "s3:read s3:write" });
    expect(JSON.parse(server.calls.at(-1)!.body)).toMatchObject({ client_name: "BE Teammate", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    await expect(discover(server.fetchFn, "https://nowhere.example.test/mcp", REDIRECT)).resolves.toBeUndefined();
  });

  it("a server that registers only loopback callbacks gets one, and the sign-in and token exchange use it", async () => {
    server.loopbackOnly();
    const oauth = await discover(server.fetchFn, MCP, REDIRECT);
    expect(oauth).toMatchObject({ clientId: "client-1", redirectUri: LOOPBACK_REDIRECT });
    expect(server.calls.filter((c) => c.url.endsWith("/register")).map((c) => JSON.parse(c.body).redirect_uris[0])).toEqual([REDIRECT, LOOPBACK_REDIRECT]);
    const c = await createConnection({ db, secretsKey: key, ssh: fakeSsh() }, "t1", { kind: "mcp", name: "wasabi", target: MCP, mode: "read-only", config: { oauth, readOnlyTools: [] } as never, personId, definitionIds: [defId] });
    const url = new URL(beginSignIn(c, REDIRECT));
    expect(url.searchParams.get("redirect_uri")).toBe(LOOPBACK_REDIRECT);
    fakeServer.challenge = url.searchParams.get("code_challenge")!;
    expect((await finishSignIn(deps, "t1", url.searchParams.get("state")!, "code-1")).status).toBe("active");
  });

  it("keeps a lifetime the server sent as text, and refreshes a token that carried none once it is old", async () => {
    server.stringExpiry();
    const oauth = await discover(server.fetchFn, MCP, REDIRECT);
    const c = await createConnection({ db, secretsKey: key, ssh: fakeSsh() }, "t1", { kind: "mcp", name: "wasabi", target: MCP, mode: "read-only", config: { oauth, readOnlyTools: [] } as never, personId, definitionIds: [defId] });
    const url = new URL(beginSignIn(c, REDIRECT));
    fakeServer.challenge = url.searchParams.get("code_challenge")!;
    await finishSignIn(deps, "t1", url.searchParams.get("state")!, "code-1");
    const stored = JSON.parse(decrypt(key, (await row()).secretCipher!));
    // "3600" counts, so the token expires in about an hour rather than never
    expect(stored.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);

    // an opaque token with no expires_in and no exp claim: 56 minutes old is stale on the usual hour
    await db.update(connections).set({ secretCipher: encrypt(key, JSON.stringify({ access: "access-1", refresh: "refresh-1", expiresAt: 0, issuedAt: Date.now() - 56 * 60_000 })) }).where(eq(connections.id, c.id));
    expect(await accessToken(deps, await row())).toBe("access-2");
  });

  it("an OAuth connection waits pending for the sign-in, then holds tokens the engine sends as a bearer header, refreshing them when stale", async () => {
    const oauth = await discover(server.fetchFn, MCP, REDIRECT);
    const c = await createConnection({ db, secretsKey: key, ssh: fakeSsh() }, "t1", { kind: "mcp", name: "wasabi", target: MCP, mode: "read-only", config: { oauth, readOnlyTools: [] } as never, personId, definitionIds: [defId] });
    expect(c.status).toBe("pending");
    expect(c.secretCipher).toBeNull();
    expect((await connectionMcpConfigs(db, key, "t1", defId, server.fetchFn)).servers).toEqual({});

    const url = new URL(beginSignIn(c, REDIRECT));
    expect(url.origin + url.pathname).toBe("https://login.example.test/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: "code", client_id: "client-1", redirect_uri: REDIRECT, code_challenge_method: "S256", resource: MCP, scope: "s3:read s3:write" });
    fakeServer.challenge = url.searchParams.get("code_challenge")!;
    const state = url.searchParams.get("state")!;
    await expect(finishSignIn(deps, "t1", "wrong-state", "code-1")).rejects.toThrow(/start it again/);
    await expect(finishSignIn(deps, "t2", state, "code-1")).rejects.toThrow(/start it again/);
    const signedIn = await finishSignIn(deps, "t1", state, "code-1");
    expect(signedIn.status).toBe("active");
    await expect(finishSignIn(deps, "t1", state, "code-1")).rejects.toThrow(/already used/); // a state is one-time
    expect(JSON.parse(decrypt(key, (await row()).secretCipher!))).toMatchObject({ access: "access-1", refresh: "refresh-1" });
    expect((await connectionMcpConfigs(db, key, "t1", defId, server.fetchFn)).servers).toEqual({ "conn-wasabi": { type: "http", url: MCP, headers: { Authorization: "Bearer access-1" } } });
    expect((await listConnections(db, "t1"))[0]!.status).toBe("active");

    // within a minute of expiry the token is refreshed and the new one stored
    await db.update(connections).set({ secretCipher: encrypt(key, JSON.stringify({ access: "access-1", refresh: "refresh-1", expiresAt: Date.now() + 30_000 })) }).where(eq(connections.id, c.id));
    expect(await accessToken(deps, await row())).toBe("access-2");
    expect(JSON.parse(decrypt(key, (await row()).secretCipher!)).access).toBe("access-2");
    expect((await connectionMcpConfigs(db, key, "t1", defId, server.fetchFn)).servers["conn-wasabi"]).toMatchObject({ headers: { Authorization: "Bearer access-2" } });

    // a refresh the server refuses: the server is left out of the turn and the connection is back to pending for a new sign-in
    server.refuse();
    await db.update(connections).set({ secretCipher: encrypt(key, JSON.stringify({ access: "access-2", refresh: "refresh-1", expiresAt: Date.now() - 1 })) }).where(eq(connections.id, c.id));
    expect((await connectionMcpConfigs(db, key, "t1", defId, server.fetchFn)).servers).toEqual({});
    expect((await row()).status).toBe("pending");
  });
});

describe("assertPublicUrl", () => {
  it("accepts a public https URL", () => {
    expect(assertPublicUrl("https://mcp.example.test/s3").hostname).toBe("mcp.example.test");
    expect(assertPublicUrl("https://93.184.216.34/mcp").hostname).toBe("93.184.216.34");
  });

  it("refuses http and private or link-local addresses", () => {
    for (const url of [
      "http://mcp.example.test/s3",
      "https://localhost/mcp",
      "https://127.0.0.1/mcp",
      "https://10.0.0.5/mcp",
      "https://172.16.0.1/mcp",
      "https://192.168.1.1/mcp",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/mcp",
      "https://[fe80::1]/mcp",
      "https://[fd00::1]/mcp",
      "https://0.0.0.0/mcp",
      "https://printer.local/mcp",
    ])
      expect(() => assertPublicUrl(url)).toThrow(/public address|https/);
  });

  it("refuses a URL that is not a URL", () => {
    expect(() => assertPublicUrl("not a url")).toThrow(/not valid/);
  });
});
