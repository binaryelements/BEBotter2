import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../db/test-db.js";
import type { Db } from "../db/client.js";
import { upsertDefinition } from "../bots/definitions.js";
import { fakeSsh } from "../connections/ssh.js";
import { connections } from "../db/schema.js";
import { createDepartment, setMembership, setRole } from "../org/directory.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { adminRouter } from "./router.js";
import { serve, sessionCookie } from "./test-server.js";

const secretsKey = Buffer.alloc(32, 7);
const T = "tenant-1";
const config = { teams: { clientId: "c", tenantId: T, clientSecret: "s" }, publicUrl: "https://bot.example.test", adminEmails: [], secretsKey };
const MCP = "https://mcp.example.test/s3";

describe("signing in to an OAuth mcp server from the admin site", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  const id: Record<string, string> = {};
  let defId: string;
  const seen: string[] = [];
  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: T });
    for (const name of ["Ann", "Hal", "Eve"]) id[name] = (await upsertPerson(db, { tenantId: T, aadObjectId: `aad-${name}`, name })).id;
    await setRole(db, T, id.Ann, "admin");
    await setMembership(db, T, (await createDepartment(db, T, "Sales")).id, id.Hal, "head");
    defId = (await upsertDefinition(db, secretsKey, T, { name: "ops", label: "Ops", persona: "p" })).id;
    // the hosted server: metadata on its own origin, registration, a token for the right code, and two tools once signed in
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      seen.push(u);
      if (u === "https://mcp.example.test/.well-known/oauth-protected-resource/s3") return new Response("nope", { status: 404 });
      if (u === "https://mcp.example.test/.well-known/oauth-protected-resource") return new Response("nope", { status: 404 });
      if (u === "https://mcp.example.test/.well-known/oauth-authorization-server") return Response.json({ authorization_endpoint: "https://mcp.example.test/authorize", token_endpoint: "https://mcp.example.test/token", registration_endpoint: "https://mcp.example.test/register" });
      if (u === "https://mcp.example.test/register") return Response.json({ client_id: "cid" });
      if (u === "https://mcp.example.test/token") return new URLSearchParams(String(init?.body)).get("code") === "good" ? Response.json({ access_token: "tok", expires_in: 3600 }) : Response.json({ error: "invalid_grant" }, { status: 400 });
      if (u === MCP) {
        if (new Headers(init?.headers).get("authorization") !== "Bearer tok") return new Response("unauthorized", { status: 401 });
        const msg = JSON.parse(String(init?.body)) as { id?: number; method: string };
        if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
        const result = msg.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools: [{ name: "list_buckets", annotations: { readOnlyHint: true } }, { name: "put_object" }] };
        return Response.json({ jsonrpc: "2.0", id: msg.id, result });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const app = express();
    app.use("/admin", adminRouter({ db, config, exchangeCode: async () => ({ id_token: "x" }), verifyIdToken: async () => ({ oid: "", tid: "", name: "", email: "" }), botName: "Bot", defaultModel: "m", fetchUsers: async () => [], fetchFn, ssh: fakeSsh() }));
    ({ url, close } = await serve(app));
  });
  afterAll(() => close());

  const get = (path: string, who: string) => fetch(url + path, { redirect: "manual", headers: { cookie: sessionCookie(secretsKey, T, id[who]) } });
  const post = (path: string, who: string, body: [string, string][]) =>
    fetch(url + path, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: sessionCookie(secretsKey, T, id[who]) }, body: new URLSearchParams([["csrf", "csrf-1"], ...body]).toString() });

  it("an admin adds the server with sign in ticked, a head signs in, and the bot gets the tools; users may not", async () => {
    const added = await post("/admin/connections", "Ann", [["name", "wasabi"], ["kind", "mcp"], ["target", MCP], ["mode", "read-only"], ["oauth", "on"], ["definitionId", defId]]);
    expect(added.status).toBe(302);
    const first = new URL(added.headers.get("location")!);
    expect(first.origin + first.pathname).toBe("https://mcp.example.test/authorize");
    expect(first.searchParams.get("redirect_uri")).toBe("https://bot.example.test/admin/connections/oauth/callback");
    const [c] = await db.select().from(connections).where(eq(connections.name, "wasabi"));
    expect(c!.status).toBe("pending");
    expect(c!.config).toEqual({ oauth: { clientId: "cid", authorizationEndpoint: "https://mcp.example.test/authorize", tokenEndpoint: "https://mcp.example.test/token" }, readOnlyTools: [] });
    const list = await (await get("/admin/connections", "Ann")).text();
    expect(list).toContain(`action="/admin/connections/${c!.id}/signin"`);

    // a department head may start the sign-in; a plain user may not
    expect((await post(`/admin/connections/${c!.id}/signin`, "Eve", [])).status).toBe(403);
    const started = await post(`/admin/connections/${c!.id}/signin`, "Hal", []);
    expect(started.status).toBe(302);
    const state = new URL(started.headers.get("location")!).searchParams.get("state")!;
    expect((await get(`/admin/connections/oauth/callback?code=good&state=${state}`, "Eve")).status).toBe(403);
    expect((await get(`/admin/connections/oauth/callback?error=access_denied&state=${state}`, "Hal")).status).toBe(400);
    expect((await get(`/admin/connections/oauth/callback?code=bad&state=${state}`, "Hal")).status).toBe(400);
    const again = new URL((await post(`/admin/connections/${c!.id}/signin`, "Hal", [])).headers.get("location")!).searchParams.get("state")!;
    const done = await get(`/admin/connections/oauth/callback?code=good&state=${again}`, "Hal");
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("Signed in to wasabi");
    const [after] = await db.select().from(connections).where(eq(connections.id, c!.id));
    expect(after!.status).toBe("active");
    expect((after!.config as { readOnlyTools: string[] }).readOnlyTools).toEqual(["list_buckets"]);
    expect(after!.secretCipher).not.toContain("tok");
    expect(await (await get("/admin/connections", "Ann")).text()).toContain("active · signed in");
    expect(seen).not.toContain("https://mcp.example.test/.well-known/openid-configuration");
  });
});
