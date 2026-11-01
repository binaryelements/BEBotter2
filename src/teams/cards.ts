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

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const keyWords = (key: string) => capital(key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase());

// RichTextBlock never renders Markdown, so text shows exactly as sent; one block per line, since a run's line breaks may not show
const exact = (text: string, bold = false) =>
  text.split(/\r?\n/).map((line, i) => ({
    type: "RichTextBlock",
    ...(i ? { spacing: "None" } : {}),
    inlines: [{ type: "TextRun", text: line || "\u00a0", ...(bold ? { weight: "Bolder" } : {}) }],
  }));

export function confirmationCard({ actionId, label, name, toolName, input }: ConfirmationRequest): AdaptiveCard {
  return card(
    [
      { type: "TextBlock", text: `${name ? `${name} (${label})` : label} wants to:`, weight: "Bolder", wrap: true },
      { type: "TextBlock", text: capital(toolWords(toolName)), wrap: true },
      ...Object.entries(input).flatMap(([key, value]) => [
        { ...exact(keyWords(key), true)[0], spacing: "Medium" },
        ...exact(typeof value === "string" ? value : JSON.stringify(value) ?? "null"),
      ]),
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
