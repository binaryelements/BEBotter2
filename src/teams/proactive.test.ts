import { describe, expect, it, vi } from "vitest";
import { testDb } from "../db/test-db.js";
import { saveConversationReference, upsertChat, upsertTenant } from "../org/org.js";
import { cachedToken, personToken, rememberToken, sendToChat } from "./proactive.js";

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

describe("personToken", () => {
  it("asks the token service for the user in the chat's stored reference, outside any turn", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: "t1" });
    await upsertChat(db, { id: "c1", tenantId: "t1", conversationType: "personal" });
    const reference = { serviceUrl: "https://example.test/", conversation: { id: "c1" }, user: { id: "29:ann" } };
    await saveConversationReference(db, "c1", reference);
    const ctx = { activity: { from: { id: "29:ann" } } };
    const continueConversation = vi.fn(async (_id: string, _ref: unknown, logic: (ctx: unknown) => Promise<void>) => logic(ctx));
    const getToken = vi.fn(async () => "tok-ann");

    await expect(personToken({ db, adapter: { continueConversation } as never, botAppId: "app-1" }, "c1", getToken)).resolves.toBe("tok-ann");
    expect(continueConversation).toHaveBeenCalledWith("app-1", reference, expect.any(Function));
    expect(getToken).toHaveBeenCalledWith(ctx);
  });

  it("has none for a chat without a stored reference", async () => {
    const db = await testDb();
    const continueConversation = vi.fn();
    await expect(personToken({ db, adapter: { continueConversation } as never, botAppId: "app-1" }, "nope", async () => "x")).resolves.toBeUndefined();
    expect(continueConversation).not.toHaveBeenCalled();
  });

  it("falls back to the token a turn already obtained, until it expires", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: "t1" });
    await upsertChat(db, { id: "c2", tenantId: "t1", conversationType: "personal" });
    await saveConversationReference(db, "c2", { serviceUrl: "https://example.test/", conversation: { id: "c2" } });
    const continueConversation = vi.fn(async (_id: string, _ref: unknown, logic: (ctx: unknown) => Promise<void>) => logic({}));
    const jwt = (exp: number) => `head.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`;
    rememberToken("c2", jwt(Math.floor(Date.now() / 1000) + 3600));
    await expect(personToken({ db, adapter: { continueConversation } as never, botAppId: "app-1" }, "c2", async () => undefined)).resolves.toBe(jwt(Math.floor(Date.now() / 1000) + 3600));
    // an expired one is dropped, and one already gone is not invented
    rememberToken("c2", jwt(Math.floor(Date.now() / 1000) - 10));
    await expect(personToken({ db, adapter: { continueConversation } as never, botAppId: "app-1" }, "c2", async () => undefined)).resolves.toBeUndefined();
    expect(cachedToken("c2")).toBeUndefined();
  });
});
