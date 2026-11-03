import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { upsertDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { connections, secretLinks } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { decrypt, encrypt } from "../secrets/cipher.js";
import { fakeSsh } from "./ssh.js";
import type { SqlRunner } from "./sql.js";
import {
  approveConnection, connectionMcpConfigs, getConnection, runHttp, runSql, listConnections, listConnectionsFor, requestConnection, resetHostKey, revokeConnection, runSsh, setLinked, verifyConnection,
} from "./store.js";

const key = randomBytes(32);
const ssh = { kind: "ssh" as const, name: "pve1", target: "pve1.example.test", mode: "read-only" as const, config: { port: 22, username: "bot" } };

describe("connections store", () => {
  let db: Db;
  let fake: ReturnType<typeof fakeSsh>;
  let deps: { db: Db; ssh: ReturnType<typeof fakeSsh>; secretsKey: Buffer; fetchFn: typeof fetch };
  let fetched: { url: string; init: RequestInit }[];
  let respond: (url: string, init: RequestInit) => Response;
  let defId: string;
  let otherDefId: string;
  let personId: string;
  beforeEach(async () => {
    db = await testDb();
    fake = fakeSsh({ hostKey: "ssh-ed25519 AAAAhost" });
    fetched = [];
    respond = () => new Response("ok");
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      fetched.push({ url: String(input), init: init ?? {} });
      return respond(String(input), init ?? {});
    }) as typeof fetch;
    deps = { db, ssh: fake, secretsKey: key, fetchFn };
    for (const t of ["t1", "t2"]) await upsertTenant(db, { id: t });
    defId = (await upsertDefinition(db, key, "t1", { name: "ops", label: "Ops", persona: "p" })).id;
    otherDefId = (await upsertDefinition(db, key, "t1", { name: "help", label: "Help", persona: "p" })).id;
    personId = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "a1", name: "Ann" })).id;
  });
  const request = (over: Partial<Parameters<typeof requestConnection>[2]> = {}, tenantId = "t1") =>
    requestConnection(deps, tenantId, { ...ssh, definitionId: defId, personId, ...over });

  it("ssh request creates a pending connection linked to the bot and returns only the public key", async () => {
    const { connection, publicKey } = await request();
    expect(connection.status).toBe("pending");
    expect(publicKey).toBe("ssh-ed25519 AAAAfake ops@pve1");
    expect(decrypt(key, connection.secretCipher!)).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect((await listConnectionsFor(db, "t1", defId)).map((c) => c.name)).toEqual(["pve1"]);
    expect(await listConnectionsFor(db, "t1", otherDefId)).toEqual([]);
  });

  it("a second request for the same name returns the same key", async () => {
    const first = await request();
    await verifyConnection(deps, "t1", defId, "pve1");
    const second = await request();
    expect(second.connection.id).toBe(first.connection.id);
    expect(second.publicKey).toBe(first.publicKey);
    // another bot cannot link itself to an existing connection by naming it
    await expect(request({ definitionId: otherDefId })).rejects.toThrow("A connection named pve1 already exists; an admin can link it to this bot on the admin page.");
    expect(await listConnectionsFor(db, "t1", otherDefId)).toEqual([]);
    await expect(request({ target: "other.example.test" })).rejects.toThrow(/already exists/);
    await expect(request({ kind: "http", target: "https://pve1.example.test/", config: {} })).rejects.toThrow(/already exists/);
  });

  it("verify pins the host key; read-only ssh becomes active, change awaits approval", async () => {
    await request();
    expect(await verifyConnection(deps, "t1", defId, "pve1")).toMatchObject({ status: "active" });
    expect(fake.calls[0]).toMatchObject({ command: "exit 0", target: { host: "pve1.example.test", port: 22, username: "bot", hostKey: null } });
    expect((await getConnection(db, "t1", "pve1"))!.hostKey).toBe("ssh-ed25519 AAAAhost");

    await request({ name: "pve2", mode: "change" });
    expect(await verifyConnection(deps, "t1", defId, "pve2")).toMatchObject({ status: "awaiting-approval" });
    await expect(runSsh(deps, "t1", defId, "pve2", "reboot", "change")).rejects.toThrow(/not active/);
    await approveConnection(db, "t1", "pve2", personId);
    const c = (await getConnection(db, "t1", "pve2"))!;
    expect(c).toMatchObject({ status: "active", approvedByPersonId: personId });
    await expect(approveConnection(db, "t1", "pve2", personId)).rejects.toThrow();
  });

  it("a first connect that records no host key does not activate", async () => {
    await request();
    deps.ssh = { ...fake, exec: async () => ({ output: "", exitCode: 0, hostKey: null, hostKeyMismatch: false }) } as typeof fake;
    const r = await verifyConnection(deps, "t1", defId, "pve1");
    expect(r.status).toBe("pending");
    expect((await getConnection(db, "t1", "pve1"))!.status).toBe("pending");
  });

  it("host key mismatch blocks the connection and runs nothing", async () => {
    await request();
    await verifyConnection(deps, "t1", defId, "pve1");
    const bad = fakeSsh({ mismatch: true });
    deps.ssh = bad;
    await expect(runSsh(deps, "t1", defId, "pve1", "uptime", "read-only")).rejects.toThrow(/host key/i);
    const c = (await getConnection(db, "t1", "pve1"))!;
    expect(c.status).toBe("blocked");
    expect(c.hostKey).toBe("ssh-ed25519 AAAAhost");
    await expect(runSsh(deps, "t1", defId, "pve1", "uptime", "read-only")).rejects.toThrow(/not active/);
    expect(bad.calls).toHaveLength(1);
    // verify does not re-pin a blocked connection either
    deps.ssh = fake;
    await expect(verifyConnection(deps, "t1", defId, "pve1")).rejects.toThrow(/blocked/);
    await resetHostKey(db, "t1", c.id);
    expect(await getConnection(db, "t1", "pve1")).toMatchObject({ status: "pending", hostKey: null });
  });

  it("ssh_read on a change connection and ssh_change on a read-only connection are refused", async () => {
    await request();
    await request({ name: "pve2", mode: "change" });
    await verifyConnection(deps, "t1", defId, "pve1");
    await verifyConnection(deps, "t1", defId, "pve2");
    await approveConnection(db, "t1", "pve2", personId);
    fake.calls.length = 0;
    await expect(runSsh(deps, "t1", defId, "pve1", "uptime", "change")).rejects.toThrow(/read-only/);
    await expect(runSsh(deps, "t1", defId, "pve2", "uptime", "read-only")).rejects.toThrow(/change/);
    expect(fake.calls).toEqual([]);
    await runSsh(deps, "t1", defId, "pve1", "uptime", "read-only");
    await runSsh(deps, "t1", defId, "pve2", "reboot", "change");
    expect(fake.calls.map((c) => c.command)).toEqual(["uptime", "reboot"]);
  });

  it("a bot not linked to the connection cannot verify or run on it", async () => {
    const { connection } = await request();
    await verifyConnection(deps, "t1", defId, "pve1");
    fake.calls.length = 0;
    await expect(verifyConnection(deps, "t1", otherDefId, "pve1")).rejects.toThrow(/No connection/);
    await expect(runSsh(deps, "t1", otherDefId, "pve1", "uptime", "read-only")).rejects.toThrow(/No connection/);
    expect(fake.calls).toEqual([]);
    await setLinked(db, "t1", otherDefId, connection.id, true);
    await runSsh(deps, "t1", otherDefId, "pve1", "uptime", "read-only");
    await setLinked(db, "t1", defId, connection.id, false);
    await expect(runSsh(deps, "t1", defId, "pve1", "uptime", "read-only")).rejects.toThrow(/No connection/);
  });

  it("revoke removes the secret and the connection cannot run", async () => {
    const { connection } = await request();
    await verifyConnection(deps, "t1", defId, "pve1");
    await db.insert(secretLinks).values([
      { id: "l1", tenantId: "t1", connectionId: connection.id, personId, tokenHash: "h1", expiresAt: new Date(Date.now() + 60_000) },
      { id: "l2", tenantId: "t1", connectionId: connection.id, personId, tokenHash: "h2", expiresAt: new Date(), usedAt: new Date() },
    ]);
    const revoked = await revokeConnection(db, "t1", connection.id);
    expect(revoked).toMatchObject({ status: "revoked", secretCipher: null });
    expect((await db.select().from(secretLinks)).map((l) => l.id)).toEqual(["l2"]);
    fake.calls.length = 0;
    await expect(runSsh(deps, "t1", defId, "pve1", "uptime", "read-only")).rejects.toThrow();
    await expect(verifyConnection(deps, "t1", defId, "pve1")).rejects.toThrow();
    expect(fake.calls).toEqual([]);
    // asking again starts over with a new key; only the asking bot stays linked, and an unlinked bot cannot claim the name
    await setLinked(db, "t1", otherDefId, connection.id, true);
    const thirdDef = (await upsertDefinition(db, key, "t1", { name: "third", label: "Third", persona: "p" })).id;
    await expect(request({ definitionId: thirdDef })).rejects.toThrow(/an admin can link it/);
    const again = await request();
    expect(await listConnectionsFor(db, "t1", otherDefId)).toEqual([]);
    expect(again.connection).toMatchObject({ id: connection.id, status: "pending", hostKey: null });
    expect(again.connection.secretCipher).toBeTruthy();
  });

  it("tenant B cannot see or run tenant A's connection", async () => {
    const { connection } = await request();
    await verifyConnection(deps, "t1", defId, "pve1");
    const bDef = (await upsertDefinition(db, key, "t2", { name: "ops", label: "Ops", persona: "p" })).id;
    fake.calls.length = 0;
    expect(await listConnections(db, "t2")).toEqual([]);
    expect(await getConnection(db, "t2", "pve1")).toBeUndefined();
    expect(await listConnectionsFor(db, "t2", defId)).toEqual([]);
    await expect(runSsh(deps, "t2", defId, "pve1", "uptime", "read-only")).rejects.toThrow();
    await expect(runSsh(deps, "t2", bDef, "pve1", "uptime", "read-only")).rejects.toThrow();
    await expect(setLinked(db, "t2", bDef, connection.id, true)).rejects.toThrow();
    await expect(revokeConnection(db, "t2", connection.id)).rejects.toThrow();
    await expect(resetHostKey(db, "t2", connection.id)).rejects.toThrow();
    await expect(approveConnection(db, "t2", "pve1", personId)).rejects.toThrow();
    await expect(requestConnection(deps, "t2", { ...ssh, definitionId: defId, personId })).rejects.toThrow();
    expect(fake.calls).toEqual([]);
    expect((await getConnection(db, "t1", "pve1"))!.status).toBe("active");
  });

  it("invalid names, option-like hosts and URLs with credentials are refused before any side effect", async () => {
    const generated: string[] = [];
    deps.ssh = { ...fake, generateKey: async (c: string) => (generated.push(c), fake.generateKey(c)) } as typeof fake;
    const bad: Partial<Parameters<typeof requestConnection>[2]>[] = [
      { name: "-pve" }, { name: "PVE" }, { name: "pve 1" }, { name: "a".repeat(64) },
      { target: "-oProxyCommand=x" }, { target: "pve1;reboot" }, { target: "user@pve1" },
      { config: { port: 22, username: "-x" } }, { config: { port: 22, username: "a b" } }, { config: { port: 0, username: "bot" } },
      { kind: "http", target: "https://u:p@api.example.test/", config: {} },
      { kind: "http", target: "https://api.example.test/#x", config: {} },
      { kind: "http", target: "ftp://api.example.test/", config: {} },
      { kind: "http", target: "api.example.test", config: {} },
      { kind: "http", target: "https://api.example.test/", config: { auth: { in: "header", name: "X Bad" } } },
      { kind: "http", target: "https://api.example.test/", config: { auth: { in: "header", name: "Authorization", prefix: `Bearer ${"x".repeat(40)}` } } },
      { kind: "mcp", target: "https://mcp.example.test/", config: { readOnlyTools: ["ok", "bad tool"] } },
      { kind: "mcp", target: "https://mcp.example.test/", config: { headerName: "X:y", readOnlyTools: [] } },
      { mode: "admin" as never },
      { kind: "ftp" as never },
    ];
    for (const b of bad) await expect(request(b)).rejects.toThrow();
    expect(generated).toEqual([]);
    expect(fake.calls).toEqual([]);
    expect(await db.select().from(connections)).toEqual([]);
  });

  const setSecret = (name: string, secret: string) => db.update(connections).set({ secretCipher: encrypt(key, secret) }).where(eq(connections.name, name));
  const http = { kind: "http" as const, name: "helpdesk", target: "https://api.example.test/v1", config: { auth: { in: "header" as const, name: "Authorization", prefix: "Bearer " } } };
  const mcp = { kind: "mcp" as const, name: "tickets", target: "https://mcp.example.test/mcp", config: { headerName: "X-Api-Key", readOnlyTools: ["list_tickets"] } };
  const mcpServer = (url: string, init: RequestInit) => {
    const msg = JSON.parse(String(init.body)) as { id?: number; method: string };
    if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = msg.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools: [{ name: "list_tickets" }, { name: "close_ticket" }] };
    return Response.json({ jsonrpc: "2.0", id: msg.id, result });
  };

  it("http and mcp requests are stored pending without a key and verify waits for a needed secret", async () => {
    const { connection, publicKey } = await request(http);
    expect(publicKey).toBeUndefined();
    expect(connection).toMatchObject({ kind: "http", status: "pending", secretCipher: null, publicKey: null });
    expect(await verifyConnection(deps, "t1", defId, "helpdesk", { path: "me" })).toEqual({ status: "pending", output: "Waiting for the secret" });
    await expect(request({ kind: "http", name: "open", target: "https://api.example.test/v1", config: {}, needsSecret: true })).rejects.toThrow(/where the secret goes/);
    expect(fetched).toEqual([]);
  });

  it("http verify is refused before approval and sends nothing; afterwards it returns only the status", async () => {
    await request(http);
    await setSecret("helpdesk", "tok-123");
    await expect(verifyConnection(deps, "t1", defId, "helpdesk", { path: "me" })).rejects.toThrow(/not approved yet.*approve/);
    expect(fetched).toEqual([]);
    expect((await getConnection(db, "t1", "helpdesk"))!.status).toBe("pending");
    await approveConnection(db, "t1", "helpdesk", personId);
    await expect(verifyConnection(deps, "t1", defId, "helpdesk")).rejects.toThrow(/probe path/);
    respond = () => new Response("secret body tok-123", { status: 401, statusText: "Unauthorized" });
    expect(await verifyConnection(deps, "t1", defId, "helpdesk", { path: "me" })).toEqual({ status: "active", output: "HTTP 401" });
    respond = () => new Response("{\"id\":1}");
    expect(await verifyConnection(deps, "t1", defId, "helpdesk", { path: "me" })).toEqual({ status: "active", output: "HTTP 200" });
    expect(fetched.at(-1)!.url).toBe("https://api.example.test/v1/me");
    expect(new Headers(fetched.at(-1)!.init.headers).get("authorization")).toBe("Bearer tok-123");
  });

  it("a corrected request replaces a pending connection's settings; an approved one keeps its own", async () => {
    await request({ ...mcp, config: { readOnlyTools: [] } });
    expect((await getConnection(db, "t1", "tickets"))!.config).toEqual({ readOnlyTools: [] });
    const { connection } = await request(mcp);
    expect(connection.config).toEqual(mcp.config);
    expect(connection.status).toBe("pending");
    await setSecret("tickets", "mcp-tok");
    await approveConnection(db, "t1", "tickets", personId);
    const again = await request({ ...mcp, config: { readOnlyTools: ["everything"] } });
    expect(again.connection.config).toEqual(mcp.config);
    expect(again.connection.status).toBe("active");
  });

  it("approve needs the secret in first and pins what the approver saw", async () => {
    await request(http);
    await expect(approveConnection(db, "t1", "helpdesk", personId)).rejects.toThrow(/secret/);
    await setSecret("helpdesk", "tok-123");
    await expect(approveConnection(db, "t1", "helpdesk", personId, { kind: "http", target: "https://evil.example.test/", mode: "read-only" })).rejects.toThrow(/not awaiting approval/);
    expect((await getConnection(db, "t1", "helpdesk"))!.status).toBe("pending");
    await approveConnection(db, "t1", "helpdesk", personId, { kind: "http", target: http.target, mode: "read-only" });
    await expect(approveConnection(db, "t1", "helpdesk", personId)).rejects.toThrow();
    expect(fetched).toEqual([]);
  });

  it("mcp verify is refused before approval and then reports the tool count only", async () => {
    await request(mcp);
    await setSecret("tickets", "mcp-tok");
    respond = mcpServer;
    await expect(verifyConnection(deps, "t1", defId, "tickets")).rejects.toThrow(/not approved yet/);
    expect(fetched).toEqual([]);
    expect((await connectionMcpConfigs(db, key, "t1", defId)).servers).toEqual({});
    await approveConnection(db, "t1", "tickets", personId);
    expect(await verifyConnection(deps, "t1", defId, "tickets")).toEqual({ status: "active", output: "Connected; 2 tools" });
    expect(new Headers(fetched[0]!.init.headers).get("x-api-key")).toBe("mcp-tok");
    expect(await connectionMcpConfigs(db, key, "t1", defId)).toEqual({
      servers: { "conn-tickets": { type: "http", url: "https://mcp.example.test/mcp", headers: { "X-Api-Key": "mcp-tok" } } },
      readOnly: [{ name: "conn-tickets", readOnlyTools: ["list_tickets"] }],
    });
    expect((await connectionMcpConfigs(db, key, "t1", otherDefId)).servers).toEqual({});
    expect((await connectionMcpConfigs(db, key, "t2", defId)).servers).toEqual({});
  });

  it("http_read refuses POST; http_change refuses a read-only connection", async () => {
    await request(http);
    await request({ ...http, name: "desk-rw", mode: "change" });
    for (const name of ["helpdesk", "desk-rw"]) {
      await setSecret(name, "tok-123");
      await approveConnection(db, "t1", name, personId);
    }
    fetched.length = 0;
    await expect(runHttp(deps, "t1", defId, "helpdesk", { method: "POST", path: "tickets", body: "{}" }, "read-only")).rejects.toThrow(/GET or HEAD/);
    await expect(runHttp(deps, "t1", defId, "helpdesk", { method: "POST", path: "tickets", body: "{}" }, "change")).rejects.toThrow(/read-only/);
    await expect(runHttp(deps, "t1", otherDefId, "desk-rw", { method: "GET", path: "me" }, "read-only")).rejects.toThrow(/No connection/);
    await expect(runHttp(deps, "t1", defId, "pve1", { method: "GET", path: "me" }, "read-only")).rejects.toThrow();
    expect(fetched).toEqual([]);
    expect(await runHttp(deps, "t1", defId, "helpdesk", { method: "GET", path: "me" }, "read-only")).toBe("HTTP 200 \nok");
    await runHttp(deps, "t1", defId, "desk-rw", { method: "GET", path: "me" }, "read-only");
    await runHttp(deps, "t1", defId, "desk-rw", { method: "POST", path: "tickets", body: "{}" }, "change");
    expect(fetched.map((f) => f.init.method)).toEqual(["GET", "GET", "POST"]);
  });

  it("sql: needs a password, contacts nothing before approval, reads in a rolled-back read-only transaction and masks the password", async () => {
    const ran: { host: string; database: string; password: string; query: string; readOnly: boolean }[] = [];
    let answer: Awaited<ReturnType<SqlRunner>> | Error = { columns: ["n", "name"], rows: [[1, "Ann"], [2, null]] };
    const sqlDeps = { ...deps, sql: (async (t, query, readOnly) => {
      ran.push({ host: t.host, database: t.database, password: t.password, query, readOnly });
      if (answer instanceof Error) throw answer;
      return answer;
    }) as SqlRunner };
    const sql = { kind: "sql" as const, name: "sap", target: "sql1.example.test", config: { engine: "mssql" as const, database: "SBO", username: "reader" } as never };
    await expect(request({ ...sql, config: { engine: "oracle", database: "x", username: "u" } as never })).rejects.toThrow(/engine/);
    await expect(request({ ...sql, target: "-oProxyCommand=x" })).rejects.toThrow(/host/);
    await expect(request({ ...sql, config: { engine: "mysql", username: "u" } as never })).rejects.toThrow(/database/);
    const { connection } = await request(sql);
    expect(connection.config).toEqual({ engine: "mssql", port: 1433, database: "SBO", username: "reader" });
    expect(connection.status).toBe("pending");
    await expect(approveConnection(db, "t1", "sap", personId)).rejects.toThrow(/secret/);
    await setSecret("sap", "pw-xyz");
    await expect(verifyConnection(sqlDeps, "t1", defId, "sap")).rejects.toThrow(/not approved yet/);
    await expect(runSql(sqlDeps, "t1", defId, "sap", "select 1", "read-only")).rejects.toThrow(/not active/);
    expect(ran).toEqual([]);
    await approveConnection(db, "t1", "sap", personId, { kind: "sql", target: sql.target, mode: "read-only" });
    expect((await verifyConnection(sqlDeps, "t1", defId, "sap")).output).toBe("Connected\nn\tname\n1\tAnn\n2\tNULL");
    expect(await runSql(sqlDeps, "t1", defId, "sap", "select n, name from t", "read-only")).toBe("n\tname\n1\tAnn\n2\tNULL");
    expect(ran.at(-1)).toEqual({ host: "sql1.example.test", database: "SBO", password: "pw-xyz", query: "select n, name from t", readOnly: true });
    await expect(runSql(sqlDeps, "t1", defId, "sap", "delete from t", "change")).rejects.toThrow(/read-only connection/);
    await expect(runSql(sqlDeps, "t1", otherDefId, "sap", "select 1", "read-only")).rejects.toThrow(/No connection/);
    answer = new Error("Login failed for user 'reader' with password pw-xyz");
    await expect(runSql(sqlDeps, "t1", defId, "sap", "select 1", "read-only")).rejects.toThrow("SQL failed: Login failed for user 'reader' with password [secret]");
    await request({ ...sql, name: "sap-rw", mode: "change" });
    await setSecret("sap-rw", "pw-2");
    await approveConnection(db, "t1", "sap-rw", personId);
    answer = { columns: [], rows: [], affected: 3 };
    expect(await runSql(sqlDeps, "t1", defId, "sap-rw", "update t set x = 1", "change")).toBe("3 rows affected");
    expect(ran.at(-1)!.readOnly).toBe(false);
  });
});
