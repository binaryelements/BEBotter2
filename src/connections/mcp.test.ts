import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { upsertDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { eq } from "drizzle-orm";
import { connections } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { connectionsMcpServer } from "./mcp.js";
import { fakeSsh } from "./ssh.js";
import { hashToken, useSecretLink } from "./secret-links.js";
import { getConnection } from "./store.js";

type Result = { isError?: boolean; content: { text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

describe("connections mcp", () => {
  let db: Db;
  const key = randomBytes(32);
  let personId: string;
  let confirmer: string | undefined;
  let call: (name: string, args?: Record<string, unknown>) => Promise<Result>;
  let callAsBob: (name: string, args?: Record<string, unknown>) => Promise<Result>;
  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: "t1" });
    const definitionId = (await upsertDefinition(db, key, "t1", { name: "ops", label: "Ops", persona: "p" })).id;
    personId = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "a1", name: "Ann" })).id;
    const bob = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "a2", name: "Bob" })).id;
    const caller = (who: string) => {
      const server = connectionsMcpServer({ db, ssh: fakeSsh({ output: "up 3 days" }), secretsKey: key, publicUrl: "https://bot.example.test", fetchFn: (async () => new Response("ok")) as typeof fetch }, { tenantId: "t1", definitionId, personId: who, confirmedBy: () => confirmer });
      const tools = (server.instance as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
      return (name: string, args: Record<string, unknown> = {}) => tools[name].handler(args);
    };
    call = caller(personId);
    callAsBob = caller(bob);
  });

  it("no tool result contains the private key", async () => {
    const results = [
      await call("request", { kind: "ssh", name: "pve1", target: "pve1.example.test", mode: "read-only", username: "bot" }),
      await call("request", { kind: "ssh", name: "pve2", target: "pve2.example.test", mode: "change", username: "bot" }),
      await call("request", { kind: "http", name: "api", target: "https://api.example.test/", mode: "read-only", auth: { in: "header", name: "Authorization" } }),
      await call("list"),
      await call("verify", { name: "pve1" }),
      await call("verify", { name: "pve2" }),
      await call("verify", { name: "api" }),
      await call("ssh_read", { name: "pve1", command: "uptime" }),
      await call("ssh_change", { name: "pve1", command: "reboot" }),
      await call("approve", { name: "pve2" }),
    ];
    expect(results[0].content[0].text).toContain("Public key: ssh-ed25519 AAAAfake ops@pve1");
    expect(results[7].content[0].text).toBe("up 3 days");
    expect(results[8].isError).toBe(true);
    for (const r of results) {
      const text = r.content.map((c) => c.text).join("\n");
      expect(text).not.toContain("BEGIN OPENSSH");
      expect(text).not.toContain("fake\n-----END");
      expect(text).not.toContain((await getConnection(db, "t1", "pve1"))!.secretCipher!);
    }
  });

  it("approve activates with the confirming person recorded", async () => {
    await call("request", { kind: "ssh", name: "pve3", target: "pve3.example.test", mode: "change", username: "bot" });
    await call("verify", { name: "pve3" });
    const details = { name: "pve3", kind: "ssh", target: "pve3.example.test", mode: "change" };
    confirmer = undefined;
    expect((await call("approve", details)).isError).toBe(true);
    confirmer = personId;
    for (const bad of [{ target: "other.example.test" }, { mode: "read-only" }, { kind: "http" }, { readOnlyTools: ["x"] }]) {
      expect((await call("approve", { ...details, ...bad })).isError).toBe(true);
      expect((await getConnection(db, "t1", "pve3"))!.status).toBe("awaiting-approval");
    }
    const r = await call("approve", details);
    expect(r.isError).toBeUndefined();
    expect(await getConnection(db, "t1", "pve3")).toMatchObject({ status: "active", approvedByPersonId: personId });
    expect((await call("ssh_change", { name: "pve3", command: "reboot" })).content[0].text).toBe("up 3 days");
  });

  it("approve of an mcp connection needs its read-only tools as stored", async () => {
    await call("request", { kind: "mcp", name: "tickets", target: "https://mcp.example.test/mcp", mode: "read-only", readOnlyTools: ["list", "get"] });
    await db.update(connections).set({ status: "awaiting-approval" }).where(eq(connections.name, "tickets"));
    confirmer = personId;
    const details = { name: "tickets", kind: "mcp", target: "https://mcp.example.test/mcp", mode: "read-only" };
    expect((await call("approve", details)).isError).toBe(true);
    expect((await call("approve", { ...details, readOnlyTools: ["list", "get", "delete"] })).isError).toBe(true);
    expect((await getConnection(db, "t1", "tickets"))!.status).toBe("awaiting-approval");
    expect((await call("approve", { ...details, readOnlyTools: ["get", "list"] })).isError).toBeUndefined();
    expect((await getConnection(db, "t1", "tickets"))!.status).toBe("active");
  });

  it("an http or mcp request that needs a secret returns a one-time link; verify waits for it", async () => {
    const r = await call("request", { kind: "mcp", name: "desk", target: "https://mcp.example.test/desk", mode: "read-only", headerName: "X-Api-Key", needsSecret: true });
    const link = r.content[0].text.match(/Secret link: (\S+)/)?.[1];
    expect(link).toMatch(/^https:\/\/bot\.example\.test\/admin\/secret\/[A-Za-z0-9_-]{43}$/);
    expect((await call("verify", { name: "desk" })).content[0].text).toBe("desk: pending\nWaiting for the secret");
    // asking again (say the link expired) gives a fresh one
    const again = (await call("request", { kind: "mcp", name: "desk", target: "https://mcp.example.test/desk", mode: "read-only", headerName: "X-Api-Key" })).content[0].text;
    expect(again).toContain("Secret link: ");
    expect(again).not.toContain(link);
    const fresh = again.match(/Secret link: (\S+)/)![1];
    // another user of the bot gets no link and leaves Ann's link working
    const bobs = (await callAsBob("request", { kind: "mcp", name: "desk", target: "https://mcp.example.test/desk", mode: "read-only", headerName: "X-Api-Key" })).content[0].text;
    expect(bobs).not.toContain("Secret link");
    expect(bobs).toContain("The secret link went to Ann");
    const token = fresh.split("/").pop()!;
    await useSecretLink(db, key, "t1", hashToken(token), personId, "tok");
    expect((await getConnection(db, "t1", "desk"))!.secretCipher).not.toBeNull();
    const plain = await call("request", { kind: "mcp", name: "open", target: "https://mcp.example.test/open", mode: "read-only" });
    expect(plain.content[0].text).not.toContain("Secret link");
  });

  it("an mcp server with its own login is registered with and the request gives a sign-in link, not a secret link", async () => {
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://mcp.example.test/.well-known/oauth-protected-resource/s3") return Response.json({ authorization_servers: ["https://login.example.test/"] });
      if (url === "https://login.example.test/.well-known/oauth-authorization-server") return Response.json({ authorization_endpoint: "https://login.example.test/authorize", token_endpoint: "https://login.example.test/token", registration_endpoint: "https://login.example.test/register" });
      if (url === "https://login.example.test/register") return Response.json({ client_id: "client-1", redirect_uris: JSON.parse(String(init?.body)).redirect_uris }, { status: 201 });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const definitionId = (await upsertDefinition(db, key, "t1", { name: "ops", label: "Ops", persona: "p" })).id;
    const server = connectionsMcpServer({ db, ssh: fakeSsh({ output: "" }), secretsKey: key, publicUrl: "https://bot.example.test", fetchFn }, { tenantId: "t1", definitionId, personId, confirmedBy: () => undefined });
    const tools = (server.instance as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
    // the bot guessed the server wants a pasted key; the server's own login wins
    const r = (await tools.request!.handler({ kind: "mcp", name: "wasabi", target: "https://mcp.example.test/s3", mode: "read-only", headerName: "Authorization", needsSecret: true })).content[0]!.text;
    const c = (await getConnection(db, "t1", "wasabi"))!;
    expect(r).toContain(`Sign-in link, for an admin or department head to open and log in to https://mcp.example.test/s3: https://bot.example.test/admin/connections/${c.id}/signin`);
    expect(r).not.toContain("Secret link");
    expect((c.config as { oauth?: { clientId: string } }).oauth?.clientId).toBe("client-1");
    expect((await tools.verify!.handler({ name: "wasabi" })).content[0]!.text).toBe("wasabi: pending\nWaiting for the sign-in");
  });

  it("an mcp server with a login that refuses to register BE Teammate is reported, not given a secret link", async () => {
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://mcp.example.test/.well-known/oauth-protected-resource/locked") return Response.json({ authorization_servers: ["https://mcp.example.test/"] });
      if (url === "https://mcp.example.test/.well-known/oauth-authorization-server") return Response.json({ authorization_endpoint: "https://mcp.example.test/oauth/authorize", token_endpoint: "https://mcp.example.test/oauth/token", registration_endpoint: "https://mcp.example.test/oauth/register" });
      if (url === "https://mcp.example.test/oauth/register") return Response.json({ error: "server_error" }, { status: 500 });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const definitionId = (await upsertDefinition(db, key, "t1", { name: "ops2", label: "Ops", persona: "p" })).id;
    const server = connectionsMcpServer({ db, ssh: fakeSsh({ output: "" }), secretsKey: key, publicUrl: "https://bot.example.test", fetchFn }, { tenantId: "t1", definitionId, personId, confirmedBy: () => undefined });
    const tools = (server.instance as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
    const r = await tools.request!.handler({ kind: "mcp", name: "locked", target: "https://mcp.example.test/locked", mode: "read-only", headerName: "Authorization", needsSecret: true });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("refused to register BE Teammate");
    expect(r.content[0]!.text).toContain("https://bot.example.test/admin/connections/oauth/callback");
    expect(await getConnection(db, "t1", "locked")).toBeUndefined();
  });
});
