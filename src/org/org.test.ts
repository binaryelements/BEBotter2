import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chats } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { saveConversationReference, upsertChat, upsertPerson, upsertTenant } from "./org.js";

describe("org", () => {
  it("creates then reuses a person, updating the name", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: "t1" });
    const a = await upsertPerson(db, { tenantId: "t1", aadObjectId: "a1", name: "Ann" });
    const b = await upsertPerson(db, { tenantId: "t1", aadObjectId: "a1", name: "Ann Lee" });
    expect(b.id).toBe(a.id);
    expect(b.name).toBe("Ann Lee");
  });
  it("stores a conversation reference on a chat", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: "t1" });
    await upsertChat(db, { id: "c1", tenantId: "t1", conversationType: "groupChat" });
    await saveConversationReference(db, "c1", { serviceUrl: "https://example.test/" });
    const chat = (await db.select().from(chats).where(eq(chats.id, "c1")))[0];
    expect(chat.conversationReference).toEqual({ serviceUrl: "https://example.test/" });
  });
});
