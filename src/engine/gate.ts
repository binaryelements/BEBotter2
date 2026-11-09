import { isReservedMcpName } from "../bots/definitions.js";
import type { BotDefinition } from "../db/schema.js";
import { BROWSER_READS } from "./browser.js";

export type ToolClass = "read" | "write" | "approve";
/** An admin's choice for one bot's tool: free runs it as a read, confirm asks as a write. */
export type ToolRule = "free" | "confirm";

// bash, ssh_read, http_read and knowledge.write are effectful. Leaving them out makes them fall through
// to "write", so each call asks; an admin may still set one free for a bot that needs it.
const BUILT_IN: Record<string, ToolClass> = {
  ...Object.fromEntries(["list", "read", "search"].map((t) => [`mcp__knowledge__${t}`, "read"])),
  ...Object.fromEntries(["list", "request", "verify", "sql_read"].map((t) => [`mcp__connections__${t}`, "read"])),
  mcp__connections__ssh_change: "write",
  mcp__connections__http_change: "write",
  mcp__connections__sql_change: "write",
  mcp__connections__approve: "approve",
  mcp__routine__remind: "read",
  mcp__routine__background: "read",
  mcp__routine__reminders: "read",
  mcp__routine__cancel_reminder: "read", // only this chat's own one-offs
  // Martin's call: anyone's teaching applies at once; admins review and undo on the bot's Learnings tab
  ...Object.fromEntries(["learn", "learnings", "update_learning", "forget"].map((t) => [`mcp__learnings__${t}`, "read" as const])),
  mcp__routine__post: "read",
  mcp__bots__tell_bot: "read", // the told bot's own tools ask their own confirmations
  mcp__attachments__read_attachment: "read",
  ...Object.fromEntries(BROWSER_READS.map((t) => [t, "read"])),
  ...Object.fromEntries(["search_mail", "list_mail", "read_mail", "read_attachment", "list_events", "find_free_time", "search_files", "read_file", "list_chats", "read_chat"].map((t) => [`mcp__m365__${t}`, "read"])),
  // Graph writes act as the person: they ask by default, and an admin may set one free per bot
  ...Object.fromEntries(["send_mail", "reply_mail", "create_event", "respond_event", "upload_file", "create_document"].map((t) => [`mcp__m365__${t}`, "write"])),
};

const MAIL_READS = new Set(["list_inboxes", "list_messages", "read_thread", "search_mail", "get_attachment", "mark_read"]);

type ConnectionServers = { name: string; readOnlyTools: string[] }[];

/** The class with no admin rule. connectionServers: approved `conn-*` MCP servers with the tools an admin marked read-only. */
export function defaultClass(toolName: string, def: BotDefinition, connectionServers: ConnectionServers = []): ToolClass {
  if (toolName === "WebSearch" || toolName === "WebFetch") return "read";
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName); // server names never contain "__" (validated on input)
  if (!m) return "write";
  // Built-ins first: a declared server cannot claim a reserved name (they are rejected on input), and anything else on one is a write.
  // m365 is ours only on a person definition; anywhere else the name is reserved, so its tools are writes
  if (BUILT_IN[toolName] && (m[1] !== "m365" || def.identity === "person")) return BUILT_IN[toolName]!;
  if (m[1] === "mail") return MAIL_READS.has(m[2]!) ? "read" : "write"; // anything not known to be a read (sending, forwarding, new tools) asks
  if (m[1]!.startsWith("conn-")) return connectionServers.find((s) => s.name === m[1])?.readOnlyTools.includes(m[2]!) ? "read" : "write";
  if (isReservedMcpName(m[1]!)) return "write";
  const server = def.mcpServers.find((s) => s.name === m[1]);
  return server?.readOnlyTools.includes(m[2]!) ? "read" : "write";
}

/** The default with the bot's rule on top; approve-class (connection approval) always asks, whatever the rule. */
export function classify(toolName: string, def: BotDefinition, connectionServers: ConnectionServers = [], rule?: ToolRule): ToolClass {
  const base = defaultClass(toolName, def, connectionServers);
  if (base === "approve" || !rule) return base;
  return rule === "free" ? "read" : "write";
}
