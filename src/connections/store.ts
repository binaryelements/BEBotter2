import { and, eq, isNull, ne, or } from "drizzle-orm";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { getDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { connections, definitionConnections, secretLinks } from "../db/schema.js";
import type { Connection, ConnectionConfig } from "../db/schema.js";
import { decrypt, encrypt } from "../secrets/cipher.js";
import { listMcpTools, sendHttp } from "./http.js";
import { accessToken, clientSecretCipher, oauthOf } from "./oauth.js";
import type { OAuthConfig } from "./oauth.js";
import type { HttpConfig, HttpRequest } from "./http.js";
import { DEFAULT_PORT, querySql, realSql, SQL_ENGINES } from "./sql.js";
import type { SqlConfig, SqlRunner } from "./sql.js";
import { validTarget } from "./ssh.js";
import type { SshRunner } from "./ssh.js";

export class ConnectionError extends Error {}

export type ConnectionDeps = { db: Db; ssh: SshRunner; secretsKey: Buffer; fetchFn: typeof fetch; sql?: SqlRunner };
export type ConnectionKind = "ssh" | "http" | "mcp" | "sql";
export type ConnectionMode = "read-only" | "change";
export type ConnectionRequest = {
  kind: ConnectionKind;
  name: string;
  target: string;
  mode: ConnectionMode;
  config: ConnectionConfig;
  /** http/mcp: the person supplies a secret through a one-time link; it needs `auth` (http) or `headerName` (mcp) to say where it goes. */
  needsSecret?: boolean;
  /** mcp OAuth: a secret the server's registration handed out, kept for token requests */
  clientSecret?: string;
  definitionId: string;
  personId: string;
};

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TOOL = /^[A-Za-z0-9_-]+$/;
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// ssh error text may name the throwaway key directory
const TEMP_PATH = /[^\s"']*bebotter-ssh-[^\s"']*/g;
const KNOWN_SSH_ERRORS = new Set(["invalid host", "invalid username", "invalid port", "host key not recorded"]);

const fail = (message: string): never => {
  throw new ConnectionError(message);
};

function checkUrl(target: string): void {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return fail("Target must be an absolute http or https URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") fail("Target must be an absolute http or https URL");
  if (u.username || u.password) fail("Target URL must not contain credentials");
  if (target.includes("#")) fail("Target URL must not contain a fragment");
}

/** Validates the request and returns the config to store, holding only the fields of its kind. */
function checkRequest(input: ConnectionRequest): ConnectionConfig {
  if (!NAME.test(input.name)) fail("Invalid connection name: lowercase letters, digits and dashes, starting with a letter or digit");
  if (input.mode !== "read-only" && input.mode !== "change") fail("Mode must be read-only or change");
  const c = input.config as Record<string, unknown>;
  if (input.kind === "ssh") {
    const t = { host: input.target, port: c.port as number, username: c.username as string };
    const invalid = validTarget(t);
    if (invalid) fail(`Invalid ssh target: ${invalid}`);
    return { port: t.port, username: t.username };
  }
  if (input.kind === "http") {
    checkUrl(input.target);
    const auth = c.auth as { in?: unknown; name?: unknown; prefix?: unknown } | undefined;
    if (!auth) return {};
    if (auth.in !== "header" && auth.in !== "query") fail("auth.in must be header or query");
    if (typeof auth.name !== "string" || !HTTP_TOKEN.test(auth.name)) fail("Invalid auth name");
    if (auth.prefix !== undefined && (typeof auth.prefix !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32} ?$/.test(auth.prefix))) fail("Invalid auth prefix");
    return { auth: { in: auth.in as "header" | "query", name: auth.name as string, ...(auth.prefix !== undefined ? { prefix: auth.prefix as string } : {}) } };
  }
  if (input.kind === "mcp") {
    checkUrl(input.target);
    const tools = c.readOnlyTools ?? [];
    if (!Array.isArray(tools) || !tools.every((t) => typeof t === "string" && TOOL.test(t))) fail("Invalid read-only tool name");
    if (c.headerName !== undefined && (typeof c.headerName !== "string" || !HTTP_TOKEN.test(c.headerName))) fail("Invalid header name");
    const oauth = c.oauth as OAuthConfig | undefined;
    if (oauth) {
      if (c.headerName) fail("A server signs in or takes a header, not both");
      if (typeof oauth.clientId !== "string" || !oauth.clientId) fail("Invalid OAuth client id");
      for (const u of [oauth.authorizationEndpoint, oauth.tokenEndpoint]) checkUrl(typeof u === "string" ? u : "");
      if (oauth.scope !== undefined && typeof oauth.scope !== "string") fail("Invalid OAuth scope");
    }
    return { ...(c.headerName !== undefined ? { headerName: c.headerName as string } : {}), ...(oauth ? { oauth } : {}), readOnlyTools: tools as string[] };
  }
  if (input.kind === "sql") {
    const engine = c.engine as SqlConfig["engine"];
    if (!SQL_ENGINES.includes(engine)) fail("engine must be postgres, mysql or mssql");
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(input.target)) fail("Target must be the database server's host name or IP address");
    const port = (c.port as number | undefined) ?? DEFAULT_PORT[engine];
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail("Invalid port");
    for (const k of ["database", "username"] as const)
      if (typeof c[k] !== "string" || !(c[k] as string).trim() || (c[k] as string).length > 128 || /[\x00-\x1f\x7f]/.test(c[k] as string)) fail(`Give the ${k}`);
    return { engine, port, database: c.database as string, username: c.username as string, ...(c.tls ? { tls: true } : {}) };
  }
  return fail("Kind must be ssh, http, mcp or sql");
}

/** Stored as its place: an http `auth` or an mcp `headerName` is where the secret goes, so having one means a secret is needed; sql always needs its password. */
export const needsSecret = (c: Pick<Connection, "kind" | "config">) =>
  c.kind === "sql" || (c.kind === "http" && "auth" in c.config && !!c.config.auth) || (c.kind === "mcp" && "headerName" in c.config && !!c.config.headerName) || !!oauthOf(c);

const byName = (tenantId: string, name: string) => and(eq(connections.tenantId, tenantId), eq(connections.name, name));
const byId = (tenantId: string, id: string) => and(eq(connections.tenantId, tenantId), eq(connections.id, id));

export const listConnections = (db: Db, tenantId: string): Promise<Connection[]> =>
  db.select().from(connections).where(eq(connections.tenantId, tenantId)).orderBy(connections.name);

export async function listConnectionsFor(db: Db, tenantId: string, definitionId: string): Promise<Connection[]> {
  const rows = await db
    .select({ c: connections })
    .from(definitionConnections)
    .innerJoin(connections, eq(definitionConnections.connectionId, connections.id))
    .where(and(eq(connections.tenantId, tenantId), eq(definitionConnections.definitionId, definitionId)))
    .orderBy(connections.name);
  return rows.map((r) => r.c);
}

export async function getConnection(db: Db, tenantId: string, name: string): Promise<Connection | undefined> {
  const [row] = await db.select().from(connections).where(byName(tenantId, name));
  return row;
}

/** The named connection, only if this bot is linked to it. */
export async function linkedConnection(db: Db, tenantId: string, definitionId: string, name: string): Promise<Connection> {
  const [row] = await db
    .select({ c: connections })
    .from(definitionConnections)
    .innerJoin(connections, eq(definitionConnections.connectionId, connections.id))
    .where(and(byName(tenantId, name), eq(definitionConnections.definitionId, definitionId)));
  return row?.c ?? fail(`No connection named ${name} for this bot`);
}

export async function setLinked(db: Db, tenantId: string, definitionId: string, connectionId: string, linked: boolean): Promise<void> {
  const [c] = await db.select({ id: connections.id }).from(connections).where(byId(tenantId, connectionId));
  if (!c) fail("Connection not found");
  if (!(await getDefinition(db, tenantId, definitionId))) fail("Bot not found");
  if (linked) await db.insert(definitionConnections).values({ definitionId, connectionId }).onConflictDoNothing();
  else await db.delete(definitionConnections).where(and(eq(definitionConnections.definitionId, definitionId), eq(definitionConnections.connectionId, connectionId)));
}

export async function requestConnection(deps: Omit<ConnectionDeps, "fetchFn">, tenantId: string, input: ConnectionRequest): Promise<{ connection: Connection; publicKey?: string }> {
  const { db } = deps;
  const config = checkRequest(input);
  if (input.needsSecret && !needsSecret({ kind: input.kind, config })) fail("Say where the secret goes: auth for http, headerName for mcp");
  const definition = await getDefinition(db, tenantId, input.definitionId);
  if (!definition) fail("Bot not found");
  const existing = await getConnection(db, tenantId, input.name);
  if (existing) {
    // linking another bot is an admin action, so an unlinked bot learns nothing more than that the name is taken
    const [link] = await db.select().from(definitionConnections)
      .where(and(eq(definitionConnections.definitionId, input.definitionId), eq(definitionConnections.connectionId, existing.id)));
    if (!link) fail(`A connection named ${input.name} already exists; an admin can link it to this bot on the admin page.`);
  }
  if (existing && existing.status !== "revoked") {
    if (existing.kind !== input.kind || existing.target !== input.target)
      fail(`A connection named ${input.name} already exists for a different ${existing.kind !== input.kind ? "kind" : "target"}`);
    // not yet approved: a corrected request (where the secret goes, read-only tools, mode) replaces the old one
    if (existing.status === "pending" && (JSON.stringify(existing.config) !== JSON.stringify(config) || existing.mode !== input.mode)) {
      // a secret given for the old settings may belong somewhere else now, so it is asked for again (an ssh key stays)
      const [row] = await db.update(connections)
        .set({ config, mode: input.mode, ...(existing.kind === "ssh" ? {} : { secretCipher: input.clientSecret ? clientSecretCipher(deps.secretsKey, input.clientSecret) : null }), updatedAt: new Date() })
        .where(and(byId(tenantId, existing.id), eq(connections.status, "pending"))).returning();
      if (row) return { connection: row, ...(row.publicKey ? { publicKey: row.publicKey } : {}) };
    }
    return { connection: existing, ...(existing.publicKey ? { publicKey: existing.publicKey } : {}) };
  }
  const key = input.kind === "ssh" ? await deps.ssh.generateKey(`${definition!.name}@${input.name}`) : undefined;
  const values = {
    kind: input.kind, target: input.target, config, mode: input.mode, status: "pending",
    secretCipher: key ? encrypt(deps.secretsKey, key.privateKey) : input.clientSecret ? clientSecretCipher(deps.secretsKey, input.clientSecret) : null, publicKey: key?.publicKey ?? null, hostKey: null,
    requestedByPersonId: input.personId, approvedByPersonId: null, updatedAt: new Date(),
  };
  // a revoked connection keeps its row and starts over; a concurrent request for a new name loses the race and gets the winner
  const [row] = existing
    ? await db.update(connections).set(values).where(and(byId(tenantId, existing.id), eq(connections.status, "revoked"))).returning()
    : await db.insert(connections).values({ id: crypto.randomUUID(), tenantId, name: input.name, ...values }).onConflictDoNothing().returning();
  if (!row) return requestConnection(deps, tenantId, input);
  // the old links were for the old target, so only the asking bot keeps one
  if (existing) await db.delete(definitionConnections).where(and(eq(definitionConnections.connectionId, row.id), ne(definitionConnections.definitionId, input.definitionId)));
  await setLinked(db, tenantId, input.definitionId, row.id, true);
  return { connection: row, ...(row.publicKey ? { publicKey: row.publicKey } : {}) };
}

export type AdminConnectionInput = Omit<ConnectionRequest, "definitionId" | "needsSecret"> & { secret?: string; definitionIds: string[] };

/** An admin sets a connection up with its secret typed in, so it is approved at once; ssh still needs its key installed and a verify, and an OAuth mcp server a sign-in. */
export async function createConnection(deps: Omit<ConnectionDeps, "fetchFn">, tenantId: string, input: AdminConnectionInput): Promise<Connection> {
  const { db } = deps;
  const config = checkRequest({ ...input, definitionId: "" });
  const signIn = !!oauthOf({ kind: input.kind, config });
  if (!signIn && needsSecret({ kind: input.kind, config }) && !input.secret?.trim()) fail(input.kind === "sql" ? "Give the password" : "Give the secret that goes in the header");
  const existing = await getConnection(db, tenantId, input.name);
  if (existing && existing.status !== "revoked") fail(`A connection named ${input.name} already exists`);
  const key = input.kind === "ssh" ? await deps.ssh.generateKey(`admin@${input.name}`) : undefined;
  const secret = key?.privateKey ?? (input.secret?.trim() || undefined);
  const values = {
    kind: input.kind, target: input.target, config, mode: input.mode, status: key || signIn ? "pending" : "active",
    secretCipher: signIn ? (input.clientSecret ? clientSecretCipher(deps.secretsKey, input.clientSecret) : null) : secret ? encrypt(deps.secretsKey, secret) : null, publicKey: key?.publicKey ?? null, hostKey: null,
    requestedByPersonId: input.personId, approvedByPersonId: input.personId, updatedAt: new Date(),
  };
  const [row] = existing
    ? await db.update(connections).set(values).where(and(byId(tenantId, existing.id), eq(connections.status, "revoked"))).returning()
    : await db.insert(connections).values({ id: crypto.randomUUID(), tenantId, name: input.name, ...values }).onConflictDoNothing().returning();
  if (!row) fail(`A connection named ${input.name} already exists`);
  if (existing) await db.delete(definitionConnections).where(eq(definitionConnections.connectionId, row!.id));
  for (const definitionId of input.definitionIds) await setLinked(db, tenantId, definitionId, row!.id, true);
  return row!;
}

/** An admin's test of any connection: ssh pins the host key and goes active (the admin approves by pressing the button). */
export async function adminVerify(deps: ConnectionDeps, tenantId: string, id: string, personId: string): Promise<string> {
  const [c] = await deps.db.select().from(connections).where(byId(tenantId, id));
  if (!c) fail("Connection not found");
  if (c!.kind === "http") return "http connections are tested by the bot with a probe path";
  const r = await verifyRow(deps, c!);
  if (r.status === "awaiting-approval") await approveConnection(deps.db, tenantId, c!.name, personId);
  return r.output;
}

async function setStatus(db: Db, c: Connection, set: Partial<Pick<Connection, "status" | "hostKey">>): Promise<void> {
  await db.update(connections).set({ ...set, updatedAt: new Date() }).where(and(byId(c.tenantId, c.id), eq(connections.status, c.status)));
}

async function exec(deps: ConnectionDeps, c: Connection, command: string) {
  if (!c.secretCipher) fail("The connection has no key");
  const { port, username } = c.config as { port: number; username: string };
  try {
    return await deps.ssh.exec({ host: c.target, port, username, privateKey: decrypt(deps.secretsKey, c.secretCipher!), hostKey: c.hostKey }, command);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (!KNOWN_SSH_ERRORS.has(msg)) console.error("ssh failed", (e as { code?: unknown } | undefined)?.code ?? "unknown");
    return fail(KNOWN_SSH_ERRORS.has(msg) ? `ssh failed: ${msg}` : "ssh could not run");
  }
}

const scrub = (output: string) => output.replace(TEMP_PATH, "<temp>");
const BLOCKED = "The host key changed, so the connection is blocked until an admin resets it";

export async function verifyConnection(
  deps: ConnectionDeps,
  tenantId: string,
  definitionId: string,
  name: string,
  probe?: { path: string },
): Promise<{ status: Connection["status"]; output: string }> {
  return verifyRow(deps, await linkedConnection(deps.db, tenantId, definitionId, name), probe);
}

async function verifyRow(deps: ConnectionDeps, c: Connection, probe?: { path: string }): Promise<{ status: Connection["status"]; output: string }> {
  const { name } = c;
  if (c.status === "revoked") fail("The connection was revoked");
  if (c.status === "blocked") fail(BLOCKED);
  if (needsSecret(c) && !c.secretCipher) return { status: c.status, output: oauthOf(c) ? "Waiting for the sign-in" : "Waiting for the secret" };
  if (c.kind !== "ssh") {
    // http, mcp and sql make no network call until a person has seen the target on the approval card
    if (c.status !== "active") fail(`${name} is not approved yet, so nothing was contacted. Ask an admin or department head to approve it.`);
    if (c.kind === "http") {
      if (!probe?.path) fail("Give a probe path: a read-only GET under the connection's URL");
      const r = await sendHttp(deps.fetchFn, httpConn(deps, c), { method: "GET", path: probe!.path });
      return { status: c.status, output: `HTTP ${r.status}` };
    }
    if (c.kind === "sql") return { status: c.status, output: `Connected\n${await querySql(deps.sql ?? realSql, sqlTarget(deps, c), "SELECT 1", true)}` };
    return { status: c.status, output: `Connected; ${(await listMcpTools(deps.fetchFn, await mcpConn(deps, c))).length} tools` };
  }
  const r = await exec(deps, c, "exit 0");
  if (r.hostKeyMismatch) {
    await setStatus(deps.db, c, { status: "blocked" });
    return { status: "blocked", output: BLOCKED };
  }
  // a first connect that recorded no host key leaves nothing to pin, so it does not count
  if (r.exitCode !== 0 || !r.hostKey) return { status: c.status, output: scrub(r.output) || "ssh failed" };
  const status = c.status === "active" || (c.mode === "read-only" && c.status === "pending") ? "active" : "awaiting-approval";
  await setStatus(deps.db, c, { status, hostKey: c.hostKey ?? r.hostKey });
  return { status, output: status === "active" ? "Connected; the connection is active" : "Connected; an admin or department head must approve it" };
}

/** `expected` pins what the approver was shown, so a connection revoked and re-requested meanwhile is not approved. */
export async function approveConnection(db: Db, tenantId: string, name: string, approverPersonId: string, expected?: { kind: Connection["kind"]; target: string; mode: ConnectionMode }): Promise<void> {
  const c = await getConnection(db, tenantId, name);
  if (c && c.kind !== "ssh" && c.status === "pending" && needsSecret(c) && !c.secretCipher) fail(`${name} is waiting for its secret`);
  // ssh is approved after verify has pinned its host key; http and mcp are approved before anything is sent to them
  const ready = or(eq(connections.status, "awaiting-approval"), and(eq(connections.status, "pending"), ne(connections.kind, "ssh")));
  const rows = await db
    .update(connections)
    .set({ status: "active", approvedByPersonId: approverPersonId, updatedAt: new Date() })
    .where(and(byName(tenantId, name), ready, ...(expected ? [eq(connections.kind, expected.kind), eq(connections.target, expected.target), eq(connections.mode, expected.mode)] : [])))
    .returning({ id: connections.id });
  if (!rows.length) fail(`${name} is not awaiting approval`);
}

export async function runSsh(deps: ConnectionDeps, tenantId: string, definitionId: string, name: string, command: string, mode: ConnectionMode): Promise<string> {
  const c = await linkedConnection(deps.db, tenantId, definitionId, name);
  if (c.kind !== "ssh") fail(`${name} is not an ssh connection`);
  if (c.status !== "active" || !c.hostKey) fail(`${name} is not active (${c.status})`);
  if (c.mode !== mode) fail(`${name} is a ${c.mode} connection; use the ${c.mode === "change" ? "ssh_change" : "ssh_read"} tool`);
  const r = await exec(deps, c, command);
  if (r.hostKeyMismatch) {
    await setStatus(deps.db, c, { status: "blocked" });
    fail(BLOCKED);
  }
  return scrub(r.output);
}

const secretOf = (deps: Pick<ConnectionDeps, "secretsKey">, c: Connection) => (c.secretCipher ? decrypt(deps.secretsKey, c.secretCipher) : undefined);
const httpConn = (deps: Pick<ConnectionDeps, "secretsKey">, c: Connection) => ({ target: c.target, config: c.config as HttpConfig, secret: secretOf(deps, c) });
/** The header an mcp server gets: the stored one, or a bearer token for a server BE Teammate signed in to. */
const mcpConn = async (deps: Pick<ConnectionDeps, "db" | "secretsKey" | "fetchFn">, c: Connection) =>
  oauthOf(c)
    ? { target: c.target, headerName: "Authorization", secret: `Bearer ${await accessToken(deps, c)}` }
    : { target: c.target, headerName: (c.config as { headerName?: string }).headerName, secret: secretOf(deps, c) };

/** http_read (GET/HEAD on any active http connection) and http_change (a change connection, confirmed per call). */
export async function runHttp(deps: ConnectionDeps, tenantId: string, definitionId: string, name: string, req: HttpRequest, mode: ConnectionMode): Promise<string> {
  const c = await linkedConnection(deps.db, tenantId, definitionId, name);
  if (c.kind !== "http") fail(`${name} is not an http connection`);
  if (c.status !== "active") fail(`${name} is not active (${c.status})`);
  if (mode === "read-only" && req.method !== "GET" && req.method !== "HEAD") fail("http_read only sends GET or HEAD; use http_change on a change connection");
  if (mode === "change" && c.mode !== "change") fail(`${name} is a read-only connection; use http_read`);
  if (needsSecret(c) && !c.secretCipher) fail(`${name} has no secret`);
  return (await sendHttp(deps.fetchFn, httpConn(deps, c), req)).text;
}

const sqlTarget = (deps: Pick<ConnectionDeps, "secretsKey">, c: Connection) => ({ ...(c.config as SqlConfig), host: c.target, password: secretOf(deps, c) ?? "" });

/** sql_read (any active sql connection, in a read-only transaction that is rolled back) and sql_change (a change connection, confirmed per call). */
export async function runSql(deps: ConnectionDeps, tenantId: string, definitionId: string, name: string, query: string, mode: ConnectionMode): Promise<string> {
  const c = await linkedConnection(deps.db, tenantId, definitionId, name);
  if (c.kind !== "sql") fail(`${name} is not an sql connection`);
  if (c.status !== "active") fail(`${name} is not active (${c.status})`);
  if (mode === "change" && c.mode !== "change") fail(`${name} is a read-only connection; use sql_read`);
  if (!c.secretCipher) fail(`${name} has no password`);
  return querySql(deps.sql ?? realSql, sqlTarget(deps, c), query, mode === "read-only");
}

/** The approved mcp connections among a bot's linked ones, and their read-only tools by `conn-*` server name. */
export const activeMcp = (linked: Connection[]) => linked.filter((c) => c.kind === "mcp" && c.status === "active");
export const mcpReadOnly = (active: Connection[]) => active.map((c) => ({ name: `conn-${c.name}`, readOnlyTools: (c.config as { readOnlyTools: string[] }).readOnlyTools }));

/** Active mcp connections linked to the bot, attached as `conn-<name>` servers, with the tools approved as read-only. */

export async function connectionMcpConfigs(
  db: Db,
  secretsKey: Buffer,
  tenantId: string,
  definitionId: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ servers: Record<string, McpServerConfig>; readOnly: { name: string; readOnlyTools: string[] }[] }> {
  const active = activeMcp(await listConnectionsFor(db, tenantId, definitionId));
  const servers: Record<string, McpServerConfig> = {};
  for (const c of active) {
    // a sign-in the server no longer honours leaves that server out of the turn; the connection is back to pending for an admin to see
    const conn = await mcpConn({ db, secretsKey, fetchFn }, c).catch((e: unknown) => void console.error(`mcp ${c.name}:`, e instanceof Error ? e.message : "error"));
    if (!conn) continue;
    const { headerName, secret } = conn;
    servers[`conn-${c.name}`] = { type: "http", url: c.target, ...(headerName && secret ? { headers: { [headerName]: secret } } : {}) };
  }
  return { servers, readOnly: mcpReadOnly(active) };
}

export async function revokeConnection(db: Db, tenantId: string, id: string): Promise<Connection> {
  const [row] = await db.update(connections).set({ status: "revoked", secretCipher: null, updatedAt: new Date() }).where(byId(tenantId, id)).returning();
  if (!row) fail("Connection not found");
  await db.delete(secretLinks).where(and(eq(secretLinks.tenantId, tenantId), eq(secretLinks.connectionId, id), isNull(secretLinks.usedAt)));
  return row;
}

export async function resetHostKey(db: Db, tenantId: string, id: string): Promise<void> {
  const rows = await db
    .update(connections)
    // without a pinned key it must be verified (and, unless read-only ssh, approved) again
    .set({ hostKey: null, status: "pending", updatedAt: new Date() })
    .where(and(byId(tenantId, id), ne(connections.status, "revoked")))
    .returning({ id: connections.id });
  if (!rows.length) fail("Connection not found");
}
