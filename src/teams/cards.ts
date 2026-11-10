import type { ConfirmationRequest } from "../engine/runner.js";

export type AdaptiveCard = Record<string, unknown>;

const card = (body: unknown[], actions?: unknown[]): AdaptiveCard => ({
  type: "AdaptiveCard",
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  version: "1.5",
  body,
  ...(actions ? { actions } : {}),
});

/** A tool's name as words: an MCP tool loses its mcp__<server>__ prefix and underscores; other tools stay as named. */
export const toolWords = (toolName: string): string => {
  const m = /^mcp__.+?__(.+)$/.exec(toolName);
  return m ? m[1]!.replace(/_/g, " ") : toolName;
};

const HOUSE_SERVERS = new Set(["m365", "mail", "knowledge", "routine", "learnings", "computer", "browser", "connections"]);
/** For an admin: the tool with where it ran: "ssh read pve1" on a connection, "Xero list invoices", "sap: list" for a connection's MCP tool. */
export const toolLabel = (toolName: string, input?: unknown): string => {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (!m) return toolName;
  const server = m[1]!;
  const words = m[2]!.replace(/[_-]+/g, " ");
  const name = (input as { name?: unknown } | undefined)?.name;
  if (server === "connections" && /^(ssh|sql|http)_(read|change)$/.test(m[2]!) && typeof name === "string") return `${words} ${name}`;
  if (server.startsWith("conn-")) return `${server.slice(5)}: ${words}`;
  return HOUSE_SERVERS.has(server) ? words : `${server} ${words}`;
};

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const keyWords = (key: string) => capital(key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase());

/** What the approval is for, in plain words: a title and a sentence saying what will happen. */
export const approval = (toolName: string, input: Record<string, unknown> = {}): { title: string; detail: string } => {
  const name = typeof input.name === "string" ? input.name : "";
  const on = name ? ` on ${name}` : "";
  const method = typeof input.method === "string" ? input.method : "GET";
  const path = typeof input.path === "string" ? input.path : "";
  if (toolName === "mcp__connections__ssh_read")
    return { title: `Read-only SSH check${on}`, detail: `Runs the command below${on} and returns its output. Nothing on the server is changed.` };
  if (toolName === "mcp__connections__ssh_change")
    return { title: `SSH change${on}`, detail: `Runs the command below${on}. It can change the server, so check it before approving.` };
  if (toolName === "mcp__connections__http_read")
    return { title: `Read-only request${name ? ` to ${name}` : ""}`, detail: `Sends ${method} ${path || "the request below"} and returns the result. Nothing is changed.` };
  if (toolName === "mcp__connections__http_change")
    return { title: `Change request${name ? ` to ${name}` : ""}`, detail: `Sends ${method} ${path || "the request below"}. It can change the external system.` };
  if (toolName === "mcp__connections__sql_read")
    return { title: `Read-only SQL query${on}`, detail: "Runs the query below in a read-only transaction that is rolled back. Nothing is changed." };
  if (toolName === "mcp__connections__sql_change")
    return { title: `SQL change${on}`, detail: "Runs the query below and commits the change." };
  if (toolName === "mcp__connections__approve")
    return { title: "Approve a connection for this bot", detail: "Check the connection's kind, target and mode below before approving." };
  const conn = /^mcp__conn-(.+?)__(.+)$/.exec(toolName);
  if (conn) return { title: `Call ${conn[2]!.replace(/_/g, " ")} on ${conn[1]}`, detail: "Review the connection's tool arguments below before approving." };
  if (toolName.startsWith("mcp__m365__")) {
    const t = toolName.slice("mcp__m365__".length);
    const text: Record<string, { title: string; detail: string }> = {
      send_mail: { title: "Send an email as you", detail: "Check the recipients and body below before approving." },
      reply_mail: { title: "Reply to an email as you", detail: "Check the body and recipients below before approving." },
      create_event: { title: "Create a calendar event as you", detail: "Check the time, attendees and body below before approving." },
      respond_event: { title: "Respond to a calendar invitation as you", detail: "This sends your response to the organiser." },
      upload_file: { title: "Save a file in your OneDrive", detail: "Check the folder, name and content below." },
      create_document: { title: "Create a Word document in your OneDrive", detail: "The document is built from the title and content below." },
    };
    if (text[t]) return text[t]!;
    return { title: capital(toolLabel(toolName, input)), detail: "Review the details below before approving." };
  }
  if (toolName.startsWith("mcp__mail__"))
    return { title: capital(toolLabel(toolName, input)), detail: "Check the message and recipients below before approving." };
  if (toolName === "mcp__computer__bash")
    return { title: "Run a command in the bot's computer", detail: "The command runs inside the bot's own container, not on your computer. Check it before approving." };
  if (toolName.startsWith("mcp__browser__"))
    return { title: "Use the bot's browser", detail: "The bot drives its browser for this step. Review the arguments below." };
  if (toolName === "WebSearch") return { title: "Search the web", detail: "This only reads search results; nothing is changed." };
  if (toolName === "WebFetch") return { title: "Fetch a web page", detail: "This only reads the page; nothing is changed." };
  return { title: capital(toolLabel(toolName, input)), detail: "Review the details below before approving." };
};

// RichTextBlock never renders Markdown, so text shows exactly as sent; one block per line, since a run's line breaks may not show
const exact = (text: string, bold = false) =>
  text.split(/\r?\n/).map((line, i) => ({
    type: "RichTextBlock",
    ...(i ? { spacing: "None" } : {}),
    inlines: [{ type: "TextRun", text: line || "\u00a0", ...(bold ? { weight: "Bolder" } : {}) }],
  }));

export function confirmationCard({ actionId, label, name, toolName, input }: ConfirmationRequest): AdaptiveCard {
  const why = approval(toolName, input);
  return card(
    [
      { type: "TextBlock", text: `${name ? `${name} (${label})` : label} wants to:`, weight: "Bolder", wrap: true },
      { type: "TextBlock", text: why.title, wrap: true },
      { type: "TextBlock", text: why.detail, isSubtle: true, spacing: "Small", wrap: true },
      ...Object.entries(input).flatMap(([key, value]) => [
        { ...exact(keyWords(key), true)[0], spacing: "Medium" },
        ...exact(typeof value === "string" ? value : JSON.stringify(value) ?? "null"),
      ]),
      { type: "TextBlock", text: "Or reply yes or no in the chat.", isSubtle: true, spacing: "Medium", wrap: true },
    ],
    [
      { type: "Action.Execute", title: "Yes, do it", verb: "confirm", data: { actionId, answer: "yes" } },
      { type: "Action.Execute", title: "No", verb: "confirm", data: { actionId, answer: "no" } },
    ],
  );
}

export const resultCard = (text: string): AdaptiveCard => card([{ type: "TextBlock", text, wrap: true }]);

export const withRoleLabel = (label: string, text: string): string => `**${label}**\n\n${text}`;

/** How a bot is named to people: `<name> · <label>`, or the label alone. */
export const botTitle = (d: { displayName: string | null; label: string }): string => (d.displayName ? `${d.displayName} · ${d.label}` : d.label);

/** One choose action per bot (Personal's always reads "My assistant"); with `chosenId`, the card also says which one the chat now talks to. */
export const chooseBotCard = (defs: { id: string; displayName: string | null; label: string; identity: "service" | "person" }[], chosenId?: string): AdaptiveCard => {
  const chosen = defs.find((d) => d.id === chosenId);
  return card(
    [
      { type: "TextBlock", text: "Who would you like to talk to?", weight: "Bolder", wrap: true },
      ...(chosen ? [{ type: "TextBlock", text: `You're now talking to ${botTitle(chosen)}.`, wrap: true }] : []),
    ],
    defs.map((d) => ({ type: "Action.Execute", title: d.identity === "person" ? "My assistant" : botTitle(d), verb: "choose", data: { definitionId: d.id } })),
  );
};
