import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { people } from "../db/schema.js";
import type { Connection } from "../db/schema.js";
import { createSecretLink } from "./secret-links.js";
import { approveConnection, ConnectionError, linkedConnection, listConnectionsFor, needsSecret, requestConnection, runHttp, runSsh, verifyConnection } from "./store.js";
import type { ConnectionDeps } from "./store.js";

type Ctx = { tenantId: string; definitionId: string; personId: string; confirmedBy: () => string | undefined };

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (e: unknown) => {
  // other errors (database, decrypt) may quote values, so only their code is logged and nothing reaches the model
  if (!(e instanceof ConnectionError)) console.error("connections tool failed", (e as { code?: unknown })?.code ?? (e instanceof Error ? e.name : "unknown"));
  return { isError: true, content: [{ type: "text" as const, text: e instanceof ConnectionError ? e.message : "Connections error" }] };
};

const facts = (c: Connection) => `${c.name}: ${c.kind} ${c.target}, ${c.mode}, ${c.status}`;

async function personName(db: Db, tenantId: string, personId: string | null): Promise<string> {
  const [p] = personId ? await db.select({ name: people.name }).from(people).where(and(eq(people.tenantId, tenantId), eq(people.id, personId))) : [];
  return p?.name ?? "someone else";
}

const READ_ONLY_RULE = "Read-only use must not change anything on the target.";

export function connectionsMcpServer(deps: ConnectionDeps & { publicUrl: string }, ctx: Ctx): McpSdkServerConfigWithInstance {
  const { db } = deps;
  const { tenantId, definitionId } = ctx;
  const run = async (f: () => Promise<string>) => {
    try {
      return ok(await f());
    } catch (e) {
      return fail(e);
    }
  };
  const sshTool = (mode: "read-only" | "change") => ({ name, command }: { name: string; command: string }) =>
    run(() => runSsh(deps, tenantId, definitionId, name, command, mode));
  return createSdkMcpServer({
    name: "connections",
    tools: [
      tool("list", "List the connections this bot may use, with kind, target, mode and status.", {}, () =>
        run(async () => (await listConnectionsFor(db, tenantId, definitionId)).map(facts).join("\n") || "No connections")),
      tool(
        "request",
        "Request access to a system. ssh: target is the host, give username (and port if not 22); you get the public key to have installed. " +
          "http: target is the base URL; auth says where the service adds the secret. mcp: target is the server URL; readOnlyTools names the tools that only read. " +
          "read-only connections must use an account or token that can only read. " +
          "Secrets are never typed into the chat: when an http or mcp connection needs one, the result holds a one-time link (30 minutes, only for the person asking); send them that link instead.",
        {
          kind: z.enum(["ssh", "http", "mcp"]),
          name: z.string(),
          target: z.string(),
          mode: z.enum(["read-only", "change"]),
          port: z.number().int().optional(),
          username: z.string().optional(),
          auth: z.object({ in: z.enum(["header", "query"]), name: z.string(), prefix: z.string().optional() }).optional(),
          headerName: z.string().optional(),
          readOnlyTools: z.array(z.string()).optional(),
          needsSecret: z.boolean().optional(),
        },
        (a) =>
          run(async () => {
            const config =
              a.kind === "ssh" ? { port: a.port ?? 22, username: a.username ?? "" }
              : a.kind === "http" ? (a.auth ? { auth: a.auth } : {})
              : { ...(a.headerName ? { headerName: a.headerName } : {}), readOnlyTools: a.readOnlyTools ?? [] };
            const { connection, publicKey } = await requestConnection(deps, tenantId, {
              kind: a.kind, name: a.name, target: a.target, mode: a.mode, config, needsSecret: a.needsSecret, definitionId, personId: ctx.personId,
            });
            const waiting = needsSecret(connection) && !connection.secretCipher && connection.status !== "revoked";
            // only the person who asked for the connection may supply its secret
            const secretLine = !waiting ? []
              : connection.requestedByPersonId === ctx.personId ? [`Secret link: ${await createSecretLink(db, tenantId, connection.id, ctx.personId, deps.publicUrl)}`]
              : [`The secret link went to ${await personName(db, tenantId, connection.requestedByPersonId)}, who asked for this connection; they can ask again for a fresh link.`];
            return [facts(connection), ...(publicKey ? [`Public key: ${publicKey}`] : []), ...secretLine].join("\n");
          }),
      ),
      tool(
        "verify",
        "Check that a requested connection works once the person says the access is in place. http and mcp connections are not contacted until approved. A changed host key blocks the connection until an admin resets it. For http give probePath, a path for a read-only GET under the connection's URL. Once a connection is active, map the system read-only and record what you learn with the knowledge tools.",
        { name: z.string(), probePath: z.string().optional() },
        ({ name, probePath }) =>
          run(async () => {
            const r = await verifyConnection(deps, tenantId, definitionId, name, probePath ? { path: probePath } : undefined);
            return `${name}: ${r.status}\n${r.output}`;
          }),
      ),
      tool(
        "approve",
        "Approve a requested connection (an ssh one after it is verified; http and mcp once their secret is in); an admin or department head confirms it. Give the connection's kind, target, mode and, for mcp, its read-only tools exactly as stored, so the approver sees what they approve.",
        {
          name: z.string(),
          kind: z.enum(["ssh", "http", "mcp"]),
          target: z.string(),
          mode: z.enum(["read-only", "change"]),
          readOnlyTools: z.array(z.string()).optional(),
        },
        (a) =>
          run(async () => {
            const approver = ctx.confirmedBy();
            if (!approver) throw new ConnectionError("Approval needs a confirmation");
            const c = await linkedConnection(db, tenantId, definitionId, a.name);
            const stored = new Set(c.kind === "mcp" ? (c.config as { readOnlyTools: string[] }).readOnlyTools : []);
            const given = new Set(a.readOnlyTools ?? []);
            const sameTools = (c.kind !== "mcp" || a.readOnlyTools !== undefined) && stored.size === given.size && [...given].every((t) => stored.has(t));
            // the card shows these arguments, so they must be what is really being approved
            if (c.kind !== a.kind || c.target !== a.target || c.mode !== a.mode || !sameTools)
              throw new ConnectionError(`The details do not match ${a.name}; nothing was approved. Stored: ${c.kind} ${c.target}, ${c.mode}`);
            await approveConnection(db, tenantId, a.name, approver, { kind: a.kind, target: a.target, mode: a.mode });
            return `${a.name}: active`;
          }),
      ),
      tool("ssh_read", `Run a command on an active read-only ssh connection. ${READ_ONLY_RULE}`, { name: z.string(), command: z.string() }, sshTool("read-only")),
      tool("ssh_change", "Run a command on an active change ssh connection; each call is confirmed in the chat unless an admin set it to run freely.", { name: z.string(), command: z.string() }, sshTool("change")),
      tool(
        "http_read",
        `Send a GET or HEAD request on an active http connection. path is relative to the connection's URL; the service adds the secret. ${READ_ONLY_RULE}`,
        { name: z.string(), path: z.string(), method: z.enum(["GET", "HEAD"]).optional(), query: z.record(z.string(), z.string()).optional(), headers: z.record(z.string(), z.string()).optional() },
        ({ name, method, ...req }) => run(() => runHttp(deps, tenantId, definitionId, name, { method: method ?? "GET", ...req }, "read-only")),
      ),
      tool(
        "http_change",
        "Send a request on an active change http connection; each call is confirmed in the chat unless an admin set it to run freely. path is relative to the connection's URL; the service adds the secret.",
        {
          name: z.string(), method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]), path: z.string(),
          query: z.record(z.string(), z.string()).optional(), headers: z.record(z.string(), z.string()).optional(), body: z.string().optional(),
        },
        ({ name, ...req }) => run(() => runHttp(deps, tenantId, definitionId, name, req, "change")),
      ),
    ],
  });
}
