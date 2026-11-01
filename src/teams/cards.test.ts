import { describe, expect, it } from "vitest";
import { chooseBotCard, confirmationCard, resultCard, toolWords, withRoleLabel } from "./cards.js";

describe("cards", () => {
  const block = (text: string, extra: Record<string, unknown> = {}, run: Record<string, unknown> = {}) => ({ type: "RichTextBlock", ...extra, inlines: [{ type: "TextRun", text, ...run }] });

  it("confirmationCard names the bot, says the action in words, and shows each argument exactly with its line breaks", () => {
    const card = confirmationCard({
      actionId: "a1",
      label: "IT Support",
      name: "Iris",
      toolName: "mcp__mail__reply_to_email",
      input: { message_id: "<m1@example.test>", body: "Hi **Martin**,\n\nDone.", cc: ["a@example.test"], replyAll: false },
    }) as any;
    expect(card.version).toBe("1.5");
    expect(card.body).toEqual([
      { type: "TextBlock", text: "Iris (IT Support) wants to:", weight: "Bolder", wrap: true },
      { type: "TextBlock", text: "Reply to email", wrap: true },
      block("Message id", { spacing: "Medium" }, { weight: "Bolder" }),
      block("<m1@example.test>"),
      block("Body", { spacing: "Medium" }, { weight: "Bolder" }),
      block("Hi **Martin**,"),
      block("\u00a0", { spacing: "None" }),
      block("Done.", { spacing: "None" }),
      block("Cc", { spacing: "Medium" }, { weight: "Bolder" }),
      block('["a@example.test"]'),
      block("Reply all", { spacing: "Medium" }, { weight: "Bolder" }),
      block("false"),
    ]);
    expect(JSON.stringify(card)).not.toContain("\\n"); // no escaped line breaks anywhere
    expect(card.actions).toEqual([
      { type: "Action.Execute", title: "Yes, do it", verb: "confirm", data: { actionId: "a1", answer: "yes" } },
      { type: "Action.Execute", title: "No", verb: "confirm", data: { actionId: "a1", answer: "no" } },
    ]);
  });

  it("confirmationCard uses the label alone without a name and keeps other tools as named", () => {
    const card = confirmationCard({ actionId: "a1", label: "Helper", toolName: "WebFetch", input: {} }) as any;
    expect(card.body).toEqual([
      { type: "TextBlock", text: "Helper wants to:", weight: "Bolder", wrap: true },
      { type: "TextBlock", text: "WebFetch", wrap: true },
    ]);
  });

  it("toolWords drops the MCP prefix and underscores only", () => {
    expect(toolWords("mcp__conn-desk__close_ticket")).toBe("close ticket");
    expect(toolWords("WebSearch")).toBe("WebSearch");
  });

  it("resultCard is one TextBlock", () => {
    expect((resultCard("Done") as any).body).toEqual([{ type: "TextBlock", text: "Done", wrap: true }]);
  });

  it("withRoleLabel prefixes a bold label", () => {
    expect(withRoleLabel("Helper", "Hi")).toBe("**Helper**\n\nHi");
  });
});

describe("chooseBotCard", () => {
  const defs = [{ id: "p", displayName: null, label: "My assistant" }, { id: "s", displayName: "Iris", label: "IT" }, { id: "t", displayName: null, label: "Sales" }];

  it("asks who, with one choose action per bot", () => {
    const card = chooseBotCard(defs) as any;
    expect(card.body).toEqual([{ type: "TextBlock", text: "Who would you like to talk to?", weight: "Bolder", wrap: true }]);
    expect(card.actions).toEqual([
      { type: "Action.Execute", title: "My assistant", verb: "choose", data: { definitionId: "p" } },
      { type: "Action.Execute", title: "Iris · IT", verb: "choose", data: { definitionId: "s" } },
      { type: "Action.Execute", title: "Sales", verb: "choose", data: { definitionId: "t" } },
    ]);
  });

  it("shows the choice", () => {
    expect((chooseBotCard(defs, "s") as any).body[1].text).toBe("You're now talking to Iris · IT.");
  });
});
