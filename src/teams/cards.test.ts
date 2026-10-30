import { describe, expect, it } from "vitest";
import { confirmationCard, resultCard, withRoleLabel } from "./cards.js";

describe("cards", () => {
  it("confirmationCard has both actions carrying the actionId", () => {
    const card = confirmationCard({ actionId: "a1", label: "Helper", summary: "Send an email", args: '{\n  "to": "a@example.test"\n}' }) as any;
    expect(card.version).toBe("1.5");
    expect(card.body[0].text).toBe("Helper wants to:");
    expect(card.body[1].text).toBe("Send an email");
    expect(card.body[2]).toEqual({ type: "TextBlock", text: '{\n  "to": "a@example.test"\n}', wrap: true, fontType: "Monospace" });
    expect(card.actions).toEqual([
      { type: "Action.Execute", title: "Yes, do it", verb: "confirm", data: { actionId: "a1", answer: "yes" } },
      { type: "Action.Execute", title: "No", verb: "confirm", data: { actionId: "a1", answer: "no" } },
    ]);
  });

  it("resultCard is one TextBlock", () => {
    expect((resultCard("Done") as any).body).toEqual([{ type: "TextBlock", text: "Done", wrap: true }]);
  });

  it("withRoleLabel prefixes a bold label", () => {
    expect(withRoleLabel("Helper", "Hi")).toBe("**Helper**\n\nHi");
  });
});
