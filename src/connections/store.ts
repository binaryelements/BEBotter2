import { and, eq, isNull, ne } from "drizzle-orm";
import { getDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { connections, definitionConnections, secretLinks } from "../db/schema.js";
import type { Connection, ConnectionConfig } from "../db/schema.js";
import { decrypt, encrypt } from "../secrets/cipher.js";
import { validTarget } from "./ssh.js";
import type { SshRunner } from "./ssh.js";

export class ConnectionError extends Error {}

export type ConnectionDeps = { db: Db; ssh: SshRunner; secretsKey: Buffer };
export type ConnectionKind = "ssh" | "http" | "mcp";
export type ConnectionMode = "read-only" | "change";
export type ConnectionRequest = {
  kind: ConnectionKind;
  name: string;
  target: string;
  mode: ConnectionMode;
  config: ConnectionConfig;
  /** http/mcp: the person must supply a secret through a one-time link (Task 6). */
  needsSecret?: boolean;
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
    if (auth.prefix !== undefined && (typeof auth.prefix !== "string" || /[\r\n\0]/.test(auth.prefix))) fail("Invalid auth prefix");
    return { auth: { in: auth.in as "header" | "query", name: auth.name as string, ...(auth.prefix !== undefined ? { prefix: auth.prefix as string } : {}) } };
  }
  if (input.kind === "mcp") {
    checkUrl(input.target);
    const tools = c.readOnlyTools ?? [];
    if (!Array.isArray(tools) || !tools.every((t) => typeof t === "string" && TOOL.test(t))) fail("Invalid read-only tool name");
    if (c.headerName !== undefined && (typeof c.headerName !== "string" || !HTTP_TOKEN.test(c.headerName))) fail("Invalid header name");
    return { ...(c.headerName !== undefined ? { headerName: c.headerName as string } : {}), readOnlyTools: tools as string[] };
  }
  return fail("Kind must be ssh, http or mcp");
}

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

export async function requestConnection(deps: ConnectionDeps, tenantId: string, input: ConnectionRequest): Promise<{ connection: Connection; publicKey?: string }> {
  const { db } = deps;
  const config = checkRequest(input);
  const definition = await getDefinition(db, tenantId, input.definitionId);
  if (!definition) fail("Bot not found");
  const existing = await getConnection(db, tenantId, input.name);
  if (existing && existing.status !== "revoked") {
    if (existing.kind !== input.kind || existing.target !== input.target)
      fail(`A connection named ${input.name} already exists for a different ${existing.kind !== input.kind ? "kind" : "target"}`);
    await setLinked(db, tenantId, input.definitionId, existing.id, true);
    return { connection: existing, ...(existing.publicKey ? { publicKey: existing.publicKey } : {}) };
  }
  const key = input.kind === "ssh" ? await deps.ssh.generateKey(`${definition!.name}@${input.name}`) : undefined;
  const values = {
    kind: input.kind, target: input.target, config, mode: input.mode, status: "pending",
    secretCipher: key ? encrypt(deps.secretsKey, key.privateKey) : null, publicKey: key?.publicKey ?? null, hostKey: null,
    requestedByPersonId: input.personId, approvedByPersonId: null, updatedAt: new Date(),
  };
  // a revoked connection keeps its row (and links) and starts over; a concurrent request for a new name loses the race and gets the winner
  const [row] = existing
    ? await db.update(connections).set(values).where(and(byId(tenantId, existing.id), eq(connections.status, "revoked"))).returning()
    : await db.insert(connections).values({ id: crypto.randomUUID(), tenantId, name: input.name, ...values }).onConflictDoNothing().returning();
  if (!row) return requestConnection(deps, tenantId, input);
  await setLinked(db, tenantId, input.definitionId, row.id, true);
  return { connection: row, ...(row.publicKey ? { publicKey: row.publicKey } : {}) };
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
    if (!KNOWN_SSH_ERRORS.has(msg)) console.error("ssh failed", (e as { code?: unknown }).code ?? "unknown");
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
  _probe?: { path: string },
): Promise<{ status: Connection["status"]; output: string }> {
  const c = await linkedConnection(deps.db, tenantId, definitionId, name);
  if (c.status === "revoked") fail("The connection was revoked");
  if (c.status === "blocked") fail(BLOCKED);
  if (c.kind !== "ssh") fail(`Verify is not available yet for ${c.kind} connections`);
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

export async function approveConnection(db: Db, tenantId: string, name: string, approverPersonId: string): Promise<void> {
  const rows = await db
    .update(connections)
    .set({ status: "active", approvedByPersonId: approverPersonId, updatedAt: new Date() })
    .where(and(byName(tenantId, name), eq(connections.status, "awaiting-approval")))
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
