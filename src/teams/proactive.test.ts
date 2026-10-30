import { describe, expect, it, vi } from "vitest";
import { testDb } from "../db/test-db.js";
import { saveConversationReference, upsertChat, upsertTenant } from "../org/org.js";
import { sendToChat } from "./proactive.js";

describe("sendToChat", () => {
  it("continues the stored conversation and sends the text", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: "t1" });
    await upsertChat(db, { id: "c1", tenantId: "t1", conversationType: "groupChat" });
    const reference = { serviceUrl: "https://example.test/", conversation: { id: "c1" } };
    await saveConversationReference(db, "c1", reference);
    const sendActivity = vi.fn(async () => undefined);
    const continueConversation = vi.fn(async (_id: string, _ref: unknown, logic: (ctx: unknown) => Promise<void>) => logic({ sendActivity }));

    await sendToChat({ db, adapter: { continueConversation } as never, botAppId: "app-1" }, "c1", "Hello");

    expect(continueConversation).toHaveBeenCalledWith("app-1", reference, expect.any(Function));
    expect(sendActivity).toHaveBeenCalledWith("Hello");
  });

  it("throws when the chat has no stored reference", async () => {
    const db = await testDb();
    const continueConversation = vi.fn();
    await expect(sendToChat({ db, adapter: { continueConversation } as never, botAppId: "app-1" }, "nope", "Hi")).rejects.toThrow(
      "No conversation reference for chat nope",
    );
    expect(continueConversation).not.toHaveBeenCalled();
  });

  it("sends a card as an adaptive card attachment", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: "t1" });
    await upsertChat(db, { id: "c1", tenantId: "t1", conversationType: "groupChat" });
    await saveConversationReference(db, "c1", { conversation: { id: "c1" } });
    const sendActivity = vi.fn(async (_a: unknown) => undefined);
    const continueConversation = vi.fn(async (_id: string, _ref: unknown, logic: (ctx: unknown) => Promise<void>) => logic({ sendActivity }));
    const card = { type: "AdaptiveCard", version: "1.5", body: [] };

    await sendToChat({ db, adapter: { continueConversation } as never, botAppId: "app-1" }, "c1", card);

    expect(sendActivity.mock.calls[0]![0]).toMatchObject({
      type: "message",
      attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }],
    });
  });
});
