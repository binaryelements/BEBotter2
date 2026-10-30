import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Connection } from "../db/schema.js";
import { approveConnection, ConnectionError, linkedConnection, listConnectionsFor, requestConnection, runSsh, verifyConnection } from "./store.js";
import type { ConnectionDeps } from "./store.js";

type Ctx = { tenantId: string; definitionId: string; personId: string; confirmedBy: () => string | undefined };

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (e: unknown) => {
  // other errors (database, decrypt) may quote values, so only their code is logged and nothing reaches the model
  if (!(e instanceof ConnectionError)) console.error("connections tool failed", (e as { code?: unknown })?.code ?? (e instanceof Error ? e.name : "unknown"));
  return { isError: true, content: [{ type: "text" as const, text: e instanceof ConnectionError ? e.message : "Connections error" }] };
};

const facts = (c: Connection) => `${c.name}: ${c.kind} ${c.target}, ${c.mode}, ${c.status}`;

const READ_ONLY_RULE = "Read-only use must not change anything on the target.";

export function connectionsMcpServer(deps: ConnectionDeps, ctx: Ctx): McpSdkServerConfigWithInstance {
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
          "read-only connections must use an account or token that can only read. Never ask anyone to paste a password, key or token into the chat.",
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
            return [facts(connection), ...(publicKey ? [`Public key: ${publicKey}`] : [])].join("\n");
          }),
      ),
      tool(
        "verify",
        "Check that a requested connection works once the person says the access is in place. A changed host key blocks the connection until an admin resets it. Once a connection is active, map the system read-only and record what you learn with the knowledge tools.",
        { name: z.string(), probePath: z.string().optional() },
        ({ name, probePath }) =>
          run(async () => {
            const r = await verifyConnection(deps, tenantId, definitionId, name, probePath ? { path: probePath } : undefined);
            return `${name}: ${r.status}\n${r.output}`;
          }),
      ),
      tool(
        "approve",
        "Approve a verified connection that awaits approval; an admin or department head confirms it.",
        { name: z.string() },
        ({ name }) =>
          run(async () => {
            const approver = ctx.confirmedBy();
            if (!approver) throw new ConnectionError("Approval needs a confirmation");
            await linkedConnection(db, tenantId, definitionId, name);
            await approveConnection(db, tenantId, name, approver);
            return `${name}: active`;
          }),
      ),
      tool("ssh_read", `Run a command on an active read-only ssh connection. ${READ_ONLY_RULE}`, { name: z.string(), command: z.string() }, sshTool("read-only")),
      tool("ssh_change", "Run a command on an active change ssh connection; each call is confirmed in the chat.", { name: z.string(), command: z.string() }, sshTool("change")),
    ],
  });
}
