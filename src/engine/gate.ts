import type { BotDefinition } from "../db/schema.js";

export function classify(toolName: string, def: BotDefinition): "read" | "write" {
  if (toolName === "WebSearch" || toolName === "WebFetch") return "read";
  // The computer holds only read-only credentials, so its shell is read.
  if (toolName === "mcp__computer__bash") return "read";
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (!m) return "write";
  const server = def.mcpServers.find((s) => s.name === m[1]);
  return server?.readOnlyTools.includes(m[2]!) ? "read" : "write";
}
