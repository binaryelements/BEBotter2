import { describe, expect, it } from "vitest";
import { upsertDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { testDb } from "../db/test-db.js";
import { createDepartment } from "../org/directory.js";
import { upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { deleteMemory, listAllMemory, memoryNote, rememberMemory, searchMemory, touchMemory, updateMemory } from "./store.js";

const secretsKey = Buffer.alloc(32, 5);
const T = "tenant-1";

const setup = async () => {
  const db: Db = await testDb();
  await upsertTenant(db, { id: T });
  const admin = (await upsertPerson(db, { tenantId: T, aadObjectId: "aad-admin", name: "Ann" })).id;
  const user = (await upsertPerson(db, { tenantId: T, aadObjectId: "aad-user", name: "Ben" })).id;
  const bot = await upsertDefinition(db, secretsKey, T, { name: "it-support", label: "IT Support", persona: "Diagnose.", model: "deepseek/deepseek-flash", mcpServers: [] });
  const other = await upsertDefinition(db, secretsKey, T, { name: "other", label: "Other", persona: "x", model: "deepseek/deepseek-flash", mcpServers: [] });
  const chat = await upsertChat(db, { id: "chat-1", tenantId: T, conversationType: "groupChat", name: "IT room" });
  const deptA = await createDepartment(db, T, "A");
  const deptB = await createDepartment(db, T, "B");
  return { db, admin, user, bot, other, chat, deptA, deptB };
};

describe("long-term memory", () => {
  it("retrieves only shared + this owner + these departments + this chat, never expired items", async () => {
    const { db, admin, user, bot, chat, deptA, deptB } = await setup();
    const shared = await rememberMemory(db, { tenantId: T, definitionId: bot.id, text: "BE Voice: check the SIP trunk registration first", importance: 5 });
    const a = await rememberMemory(db, { tenantId: T, definitionId: bot.id, departmentId: deptA.id, text: "Department A keeps its SBC in the Melbourne rack" });
    const b = await rememberMemory(db, { tenantId: T, definitionId: bot.id, departmentId: deptB.id, text: "Department B uses a different carrier" });
    const room = await rememberMemory(db, { tenantId: T, definitionId: bot.id, chatId: chat.id, text: "This room's BE Voice test number is 1234" });
    const mine = await rememberMemory(db, { tenantId: T, definitionId: bot.id, ownerPersonId: user, text: "Ben prefers a short report" });
    const stale = await rememberMemory(db, { tenantId: T, definitionId: bot.id, text: "Temporary carrier maintenance", expiresAt: new Date(Date.now() - 1_000) });

    const found = await searchMemory(db, { tenantId: T, definitionId: bot.id, departmentIds: [deptA.id], chatId: chat.id }, "BE Voice trunk", 10);
    const ids = found.map((m) => m.id);
    expect(ids).toContain(shared.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(mine.id);
    expect(ids).not.toContain(stale.id);

    const ben = await searchMemory(db, { tenantId: T, definitionId: bot.id, ownerPersonId: user, departmentIds: [deptA.id], chatId: chat.id }, "short report", 10);
    expect(ben.map((m) => m.id)).toContain(mine.id);

    const noChat = await searchMemory(db, { tenantId: T, definitionId: bot.id, departmentIds: [deptA.id] }, "", 20);
    expect(noChat.map((m) => m.id)).toContain(shared.id);
    expect(noChat.map((m) => m.id)).not.toContain(room.id);

    // never a different bot's memory
    const wrongBot = await searchMemory(db, { tenantId: T, definitionId: "nope", departmentIds: [deptA.id], chatId: chat.id }, "BE Voice", 10);
    expect(wrongBot).toEqual([]);
    expect((await listAllMemory(db, T, bot.id)).map((m) => m.id)).toEqual(expect.arrayContaining([shared.id, a.id, b.id, room.id, mine.id, stale.id]));
    expect(admin).toBeTruthy();
  });

  it("ranks an exact match above a merely important item", async () => {
    const { db, bot } = await setup();
    const important = await rememberMemory(db, { tenantId: T, definitionId: bot.id, text: "Always be polite", importance: 5 });
    const exact = await rememberMemory(db, { tenantId: T, definitionId: bot.id, text: "BE Voice SIP trunk registration", importance: 1 });
    const found = await searchMemory(db, { tenantId: T, definitionId: bot.id }, "SIP trunk", 10);
    expect(found[0].id).toBe(exact.id);
    expect(found.map((m) => m.id)).toContain(important.id);
  });

  it("touches, rewrites and deletes an item", async () => {
    const { db, bot } = await setup();
    const m = await rememberMemory(db, { tenantId: T, definitionId: bot.id, text: "Ask for the call id" });
    await touchMemory(db, [m.id]);
    const [used] = await listAllMemory(db, T, bot.id);
    expect(used.useCount).toBe(1);
    expect(used.lastUsedAt).not.toBeNull();
    await updateMemory(db, T, bot.id, m.id, { text: "Ask for the call id first", importance: 4 });
    expect((await listAllMemory(db, T, bot.id))[0]).toMatchObject({ text: "Ask for the call id first", importance: 4 });
    await deleteMemory(db, T, bot.id, m.id);
    expect(await listAllMemory(db, T, bot.id)).toEqual([]);
  });

  it("refuses secrets", async () => {
    const { db, bot } = await setup();
    await expect(rememberMemory(db, { tenantId: T, definitionId: bot.id, text: "password: hunter2" })).rejects.toThrow("password");
  });

  it("formats a capped note for the prompt", async () => {
    const { db, bot } = await setup();
    const m = await rememberMemory(db, { tenantId: T, definitionId: bot.id, text: "x".repeat(600), kind: "procedure", importance: 4 });
    const note = memoryNote([m], 100);
    expect(note).toContain("[procedure]");
    expect(note).toContain("…");
    expect(memoryNote([])).toBe("");
  });
});
