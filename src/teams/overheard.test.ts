import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { chatMessages } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { upsertChat, upsertTenant } from "../org/org.js";
import { pruneOverheard, recordOverheard, setChatListening, takeOverheard, withOverheard } from "./overheard.js";

describe("overheard", () => {
  it("keeps what a listening chat says, hands it over once, oldest first, and not when listening is off", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: "t1" });
    await upsertChat(db, { id: "g1", tenantId: "t1", conversationType: "groupChat" });
    const t0 = new Date("2026-11-03T10:00:00Z");
    expect(await recordOverheard(db, { tenantId: "t1", chatId: "g1", name: "Ann", text: "the printer\n  is down again", at: t0 })).toBe(true);
    expect(await recordOverheard(db, { tenantId: "t1", chatId: "g1", name: "Bob", text: "   ", at: t0 })).toBe(false);
    expect(await recordOverheard(db, { tenantId: "t1", chatId: "g1", name: "Bob", text: "I'll look", at: new Date(t0.getTime() + 1000) })).toBe(true);
    expect(await takeOverheard(db, "g1")).toEqual(["Ann: the printer is down again", "Bob: I'll look"]);
    expect(await takeOverheard(db, "g1")).toEqual([]);
    expect(withOverheard(["Ann: hi"], "Mickey, what was that?")).toBe("[Said in this group chat since your last reply; you were not addressed, so you did not answer:\nAnn: hi]\n\nMickey, what was that?");
    expect(withOverheard([], "hi")).toBe("hi");
    await setChatListening(db, "t1", "g1", false);
    expect(await recordOverheard(db, { tenantId: "t1", chatId: "g1", name: "Ann", text: "secret" })).toBe(false);
    expect(await db.select().from(chatMessages).where(eq(chatMessages.chatId, "g1"))).toHaveLength(2);
    expect(await pruneOverheard(db, "t1", 30, new Date("2026-12-10T00:00:00Z"))).toBe(2);
  });
});
