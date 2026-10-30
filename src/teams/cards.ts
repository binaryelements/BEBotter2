import type { ConfirmationRequest } from "../engine/runner.js";

export type AdaptiveCard = Record<string, unknown>;

const card = (body: unknown[], actions?: unknown[]): AdaptiveCard => ({
  type: "AdaptiveCard",
  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
  version: "1.5",
  body,
  ...(actions ? { actions } : {}),
});

export function confirmationCard({ actionId, label, summary, args }: ConfirmationRequest): AdaptiveCard {
  return card(
    [
      { type: "TextBlock", text: `${label} wants to:`, weight: "Bolder" },
      { type: "TextBlock", text: summary, wrap: true },
      { type: "TextBlock", text: args, wrap: true, fontType: "Monospace" },
    ],
    [
      { type: "Action.Execute", title: "Yes, do it", verb: "confirm", data: { actionId, answer: "yes" } },
      { type: "Action.Execute", title: "No", verb: "confirm", data: { actionId, answer: "no" } },
    ],
  );
}

export const resultCard = (text: string): AdaptiveCard => card([{ type: "TextBlock", text, wrap: true }]);

export const withRoleLabel = (label: string, text: string): string => `**${label}**\n\n${text}`;
