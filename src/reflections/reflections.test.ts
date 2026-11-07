import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { completeAction, beginAction } from "../audit/audit.js";
import { upsertDefinition, setReflectionSettings } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { sessions } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import type { Engine } from "../engine/engine.js";
import { addLearning, listLearnings } from "../learnings/store.js";
import { listAllMemory } from "../memory/store.js";
import { setRole } from "../org/directory.js";
import { recordChatOwner, upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { runReflection } from "./run.js";
import { runReflectionTick } from "./scheduler.js";
import { applyLearningAction, createProposal, dayInZone, decideProposal, hourInZone, listProposals, listReflections, reflectionKey, saveReflection } from "./store.js";

const secretsKey = Buffer.alloc(32, 5);
const T = "tenant-1";
const MODEL = "deepseek/deepseek-flash";
const DAY = "2026-11-07";

describe("reflection store", () => {
  let db: Db;
  let admin: string;
  let user: string;
  let botId: string;
  let chatId: string;

  beforeEach(async () => {
    db = await testDb();
    await upsertTenant(db, { id: T, name: "BE" });
    admin = (await upsertPerson(db, { tenantId: T, aadObjectId: "aad-admin", name: "Ann" })).id;
    user = (await upsertPerson(db, { tenantId: T, aadObjectId: "aad-user", name: "Ben" })).id;
    await setRole(db, T, admin, "admin");
    botId = (await upsertDefinition(db, secretsKey, T, { name: "it-support", label: "IT Support", persona: "Diagnose.", model: MODEL, mcpServers: [] })).id;
    chatId = (await upsertChat(db, { id: "chat-1", tenantId: T, conversationType: "groupChat", name: "IT room" })).id;
    await recordChatOwner(db, chatId, user);
  });

  it("puts a date and hour in the tenant zone", () => {
    const at = new Date("2026-11-07T23:30:00Z");
    expect(dayInZone(at, "Australia/Sydney")).toBe("2026-11-08");
    expect(hourInZone(at, "Australia/Sydney")).toBe(10);
    expect(dayInZone(at, "UTC")).toBe("2026-11-07");
  });

  it("saves one reflection per bot and day", async () => {
    const first = await saveReflection(db, { tenantId: T, definitionId: botId, day: DAY, summary: "first", model: MODEL, costUsd: 0.001 });
    const second = await saveReflection(db, { tenantId: T, definitionId: botId, day: DAY, summary: "second", model: MODEL });
    expect(second.id).toBe(first.id);
    expect(second.summary).toBe("first");
    expect(reflectionKey(T, botId, null, DAY)).toBe(`${T}:${botId}::${DAY}`);
  });

  it("approving a proposal applies the add, update and remove", async () => {
    const learning = await addLearning(db, T, { definitionId: botId, text: "Call scheduled runs reminders", taughtByPersonId: admin });

    const add = await createProposal(db, { tenantId: T, definitionId: botId, action: "add", text: "Check the SBC before escalating" });
    expect((await decideProposal(db, T, botId, add.id, "approved", admin)).status).toBe("approved");
    expect((await listLearnings(db, T, botId)).map((l) => l.text)).toContain("Check the SBC before escalating");

    const update = await createProposal(db, { tenantId: T, definitionId: botId, action: "update", learningId: learning.id, text: "Say reminders, not scheduled runs" });
    await decideProposal(db, T, botId, update.id, "approved", admin);
    expect((await listLearnings(db, T, botId)).some((l) => l.text === "Say reminders, not scheduled runs")).toBe(true);

    const remove = await createProposal(db, { tenantId: T, definitionId: botId, action: "remove", learningId: learning.id, reason: "no longer true" });
    await decideProposal(db, T, botId, remove.id, "approved", admin);
    expect((await listLearnings(db, T, botId)).some((l) => l.id === learning.id)).toBe(false);
  });

  it("rejecting a proposal changes nothing", async () => {
    const add = await createProposal(db, { tenantId: T, definitionId: botId, action: "add", text: "Never do this" });
    expect((await decideProposal(db, T, botId, add.id, "rejected", admin)).status).toBe("rejected");
    expect(await listLearnings(db, T, botId)).toEqual([]);
    expect((await listProposals(db, T, botId, "pending")).length).toBe(0);
  });

  it("auto mode applies an action immediately", async () => {
    await applyLearningAction(db, { tenantId: T, definitionId: botId, action: "add", text: "Ask for the call id", personId: admin });
    const [learning] = await listLearnings(db, T, botId);
    expect(learning.text).toBe("Ask for the call id");
    expect(learning.source).toBe("reflection");
    await applyLearningAction(db, { tenantId: T, definitionId: botId, action: "update", learningId: learning.id, text: "Ask for the call id first", personId: admin });
    expect((await listLearnings(db, T, botId))[0].text).toBe("Ask for the call id first");
    await applyLearningAction(db, { tenantId: T, definitionId: botId, action: "remove", learningId: learning.id, personId: admin });
    expect(await listLearnings(db, T, botId)).toEqual([]);
  });

  it("refuses a learning that looks like a secret", async () => {
    await expect(addLearning(db, T, { definitionId: botId, text: "password: hunter2", taughtByPersonId: admin })).rejects.toThrow("password");
    await expect(addLearning(db, T, { definitionId: botId, text: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc", taughtByPersonId: admin })).rejects.toThrow("private key");
  });

  it("refuses a learning that belongs to another owner or bot", async () => {
    const other = await upsertDefinition(db, secretsKey, T, { name: "other", label: "Other", persona: "x", model: MODEL, mcpServers: [] });
    const l = await addLearning(db, T, { definitionId: other.id, text: "Other bot's rule", taughtByPersonId: admin });
    await expect(applyLearningAction(db, { tenantId: T, definitionId: botId, action: "remove", learningId: l.id, personId: admin })).rejects.toThrow("No such learning");
    expect((await listLearnings(db, T, other.id)).map((x) => x.id)).toContain(l.id);
  });
});

describe("reflection runner", () => {
  let db: Db;
  let admin: string;
  let botId: string;
  let chatId: string;
  let day: string;

  const seed = async () => {
    db = await testDb();
    await upsertTenant(db, { id: T, name: "BE" });
    admin = (await upsertPerson(db, { tenantId: T, aadObjectId: "aad-admin", name: "Ann" })).id;
    await setRole(db, T, admin, "admin");
    botId = (await upsertDefinition(db, secretsKey, T, { name: "it-support", label: "IT Support", persona: "Diagnose.", model: MODEL, mcpServers: [] })).id;
    chatId = (await upsertChat(db, { id: "chat-1", tenantId: T, conversationType: "groupChat", name: "IT room" })).id;
    day = dayInZone(new Date(), "UTC");
    const id = await beginAction(db, { tenantId: T, chatId, definitionId: botId, personId: admin, kind: "message", summary: "I can't access BE Voice", model: MODEL });
    await completeAction(db, id, { status: "done" });
    await db.insert(sessions).values({
      chatId,
      definitionId: botId,
      messages: [
        { role: "user", text: "I can't access BE Voice" },
        { role: "assistant", text: "I checked the trunk and it is registered." },
        { role: "user", text: "No, check the SBC first next time" },
      ],
      updatedAt: new Date(),
    });
  };

  const engine = (mode: "propose" | "auto", seen: { posts: string[]; tools: string[] }): Engine => ({
    run: async (input) => {
      seen.tools = input.tools.map((t) => t.name);
      const activity = await input.callTool("mcp__reflection__activity", {});
      expect(activity.text).toContain("I can't access BE Voice");
      const conversation = await input.callTool("mcp__reflection__conversation", { chatId });
      expect(conversation.text).toContain("check the SBC first");
      const learnings = await input.callTool("mcp__reflection__learnings", {});
      expect(learnings.text).toBeDefined();
      await input.callTool("mcp__reflection__learn", { text: "Check the SBC before the trunk" });
      await input.callTool("mcp__reflection__remember", { text: "BE Voice: check the SIP trunk first", kind: "procedure", importance: 4 });
      const memory = await input.callTool("mcp__reflection__memory", { query: "SIP trunk" });
      expect(memory.text).toContain("SIP trunk first");
      if (mode === "auto") {
        await input.callTool("mcp__reflection__post", { text: "I learnt to check the SBC first. I will do that before escalating." });
        seen.posts.push("posted");
      }
      await input.callTool("mcp__reflection__finish", {
        summary: "One BE Voice issue.",
        wentWell: "The trunk check was quick.",
        wentWrong: "The SBC was checked too late.",
        corrections: "Ben said to check the SBC first.",
        willDo: "Check the SBC before the trunk.",
      });
      return { text: "done", messages: [], usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.001 }, steps: 1, stopReason: "text" };
    },
  });

  it("propose mode leaves a pending learning and saves the day's summary", async () => {
    await seed();
    const seen = { posts: [] as string[], tools: [] as string[] };
    const row = await runReflection({ db, engine: engine("propose", seen) }, { tenantId: T, definition: (await upsertDefinition(db, secretsKey, T, { name: "it-support", label: "IT Support", persona: "Diagnose.", model: MODEL, mcpServers: [] })), ownerPersonId: null, day, timeZone: "UTC", mode: "propose", defaultChatId: null });
    expect(row?.summary).toBe("One BE Voice issue.");
    const proposals = await listProposals(db, T, botId, "pending");
    expect(proposals.map((p) => p.text)).toContain("Check the SBC before the trunk");
    expect(await listLearnings(db, T, botId)).toEqual([]);
    expect((await listAllMemory(db, T, botId)).map((m) => m.text)).toContain("BE Voice: check the SIP trunk first");
    expect(seen.posts).toEqual([]);
    expect(seen.tools).toContain("mcp__reflection__learn");
    expect(seen.tools).not.toContain("mcp__reflection__post");
  });

  it("auto mode applies the learning and posts to the group", async () => {
    await seed();
    const seen = { posts: [] as string[], tools: [] as string[] };
    const posts: { chatId: string; text: string }[] = [];
    const row = await runReflection(
      { db, engine: engine("auto", seen), send: async (id, text) => void posts.push({ chatId: id, text }) },
      { tenantId: T, definition: (await upsertDefinition(db, secretsKey, T, { name: "it-support", label: "IT Support", persona: "Diagnose.", model: MODEL, mcpServers: [] })), ownerPersonId: null, day, timeZone: "UTC", mode: "auto", defaultChatId: chatId },
    );
    expect(row?.wentWrong).toBe("The SBC was checked too late.");
    expect((await listLearnings(db, T, botId)).map((l) => l.text)).toContain("Check the SBC before the trunk");
    expect(posts).toEqual([{ chatId, text: "I learnt to check the SBC first. I will do that before escalating." }]);
    expect(seen.tools).toContain("mcp__reflection__post");
  });

  it("auto mode posts the summary when the agent does not post", async () => {
    await seed();
    const posts: { chatId: string; text: string }[] = [];
    const engine: Engine = {
      run: async (input) => {
        await input.callTool("mcp__reflection__finish", { summary: "Quiet day.", willDo: "Keep checking the SBC." });
        return { text: "done", messages: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, steps: 1, stopReason: "text" };
      },
    };
    await runReflection(
      { db, engine, send: async (id, text) => void posts.push({ chatId: id, text }) },
      { tenantId: T, definition: (await upsertDefinition(db, secretsKey, T, { name: "it-support", label: "IT Support", persona: "Diagnose.", model: MODEL, mcpServers: [] })), ownerPersonId: null, day, timeZone: "UTC", mode: "auto", defaultChatId: chatId },
    );
    expect(posts).toEqual([{ chatId, text: "Daily review for IT Support: Quiet day. I will Keep checking the SBC." }]);
  });

  it("the scheduler reflects once at the chosen hour and does not repeat", async () => {
    await seed();
    await setReflectionSettings(db, T, botId, { mode: "propose", chatId: null, hour: 18 });
    const before = await beginAction(db, { tenantId: T, chatId, definitionId: botId, personId: admin, kind: "message", summary: "Review me", model: MODEL, startedAt: new Date("2026-11-07T10:00:00Z") });
    await completeAction(db, before, { status: "done" });
    const engine: Engine = {
      run: async (input) => {
        await input.callTool("mcp__reflection__finish", { summary: "Scheduled review." });
        return { text: "done", messages: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, steps: 1, stopReason: "text" };
      },
    };
    await runReflectionTick({ db, engine, now: () => new Date("2026-11-07T18:05:00Z") });
    const rows = await listReflections(db, T, botId);
    expect(rows.length).toBe(1);
    expect(rows[0].day).toBe("2026-11-07");
    expect(rows[0].summary).toBe("Scheduled review.");
    // a second pass on the same day does not duplicate it
    await runReflectionTick({ db, engine, now: () => new Date("2026-11-07T18:35:00Z") });
    expect((await listReflections(db, T, botId)).length).toBe(1);
  });
});
