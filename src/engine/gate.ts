import type { BotDefinition } from "../db/schema.js";

export function classify(toolName: string, def: BotDefinition): "read" | "write" {
  if (toolName === "WebSearch" || toolName === "WebFetch") return "read";
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName); // server names never contain "__" (validated on input)
  if (!m) return "write";
  const server = def.mcpServers.find((s) => s.name === m[1]);
  if (server) return server.readOnlyTools.includes(m[2]!) ? "read" : "write";
  // Only when no declared server claims the name: the built-in computer holds read-only credentials.
  return toolName === "mcp__computer__bash" ? "read" : "write";
}
