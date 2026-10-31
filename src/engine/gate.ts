import { isReservedMcpName } from "../bots/definitions.js";
import type { BotDefinition } from "../db/schema.js";

export type ToolClass = "read" | "write" | "approve";

const BUILT_IN: Record<string, ToolClass> = {
  ...Object.fromEntries(["list", "read", "search", "write"].map((t) => [`mcp__knowledge__${t}`, "read"])),
  ...Object.fromEntries(["list", "request", "verify", "ssh_read", "http_read"].map((t) => [`mcp__connections__${t}`, "read"])),
  mcp__connections__ssh_change: "write",
  mcp__connections__http_change: "write",
  mcp__connections__approve: "approve",
  mcp__routine__remind: "read",
  mcp__routine__post: "read",
  mcp__computer__bash: "read",
};

/** connectionServers: approved `conn-*` MCP servers with the tools an admin marked read-only. */
export function classify(toolName: string, def: BotDefinition, connectionServers: { name: string; readOnlyTools: string[] }[] = []): ToolClass {
  if (toolName === "WebSearch" || toolName === "WebFetch") return "read";
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName); // server names never contain "__" (validated on input)
  if (!m) return "write";
  // Built-ins first: a declared server cannot claim a reserved name (they are rejected on input), and anything else on one is a write.
  if (BUILT_IN[toolName]) return BUILT_IN[toolName]!;
  if (m[1]!.startsWith("conn-")) return connectionServers.find((s) => s.name === m[1])?.readOnlyTools.includes(m[2]!) ? "read" : "write";
  if (isReservedMcpName(m[1]!)) return "write";
  const server = def.mcpServers.find((s) => s.name === m[1]);
  return server?.readOnlyTools.includes(m[2]!) ? "read" : "write";
}
