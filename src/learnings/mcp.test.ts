import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { upsertDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { testDb } from "../db/test-db.js";
import { upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { listAllMemory } from "../memory/store.js";
import { learningsMcpServer } from "./mcp.js";
import { MAX_LEARNINGS, addLearning, learningsNote, listLearnings } from "./store.js";

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;
const toolsOf = (s: ReturnType<typeof learningsMcpServer>) => (s.instance as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;

describe("learnings", () => {
  let db: Db;
  let ann: string;
  let bob: string;
  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: "t1" });
    await upsertChat(db, { id: "c1", tenantId: "t1", conversationType: "personal" });
    await upsertChat(db, { id: "c2", tenantId: "t1", conversationType: "personal" });
    ann = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "a1", name: "Ann" })).id;
    bob = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "b1", name: "Bob" })).id;
  });

  it("a shared bot learns, lists, rewords and forgets, and what it learnt is for everyone", async () => {
    const definitionId = (await upsertDefinition(db, randomBytes(32), "t1", { name: "ops", label: "Ops", persona: "p" })).id;
    const t = toolsOf(learningsMcpServer({ db }, { tenantId: "t1", definitionId, chatId: "c1", personId: ann }, false));
    expect((await t.learn.handler({ text: "  Call scheduled runs reminders  " })).isError).toBeUndefined();
    const [l] = await listLearnings(db, "t1", definitionId, null);
    expect(l).toMatchObject({ text: "Call scheduled runs reminders", taughtByPersonId: ann, chatId: "c1", ownerPersonId: null });
    expect((await t.learnings.handler({})).content[0]!.text).toContain(`${l!.id} |`);
    // Bob, in another chat, sees and can change it
    const b = toolsOf(learningsMcpServer({ db }, { tenantId: "t1", definitionId, chatId: "c2", personId: bob }, false));
    expect((await b.update_learning.handler({ id: l!.id, text: "Say reminders, not scheduled runs" })).isError).toBeUndefined();
    expect((await listLearnings(db, "t1", definitionId))[0]!.text).toBe("Say reminders, not scheduled runs");
    for (const bad of ["", "x".repeat(1001)]) expect((await t.learn.handler({ text: bad })).isError).toBe(true);
    expect((await b.forget.handler({ id: l!.id })).isError).toBeUndefined();
    expect(await listLearnings(db, "t1", definitionId)).toHaveLength(0);
    expect((await b.forget.handler({ id: l!.id })).isError).toBe(true);
  });

  it("on Personal a learning is the teacher's own: another person neither reads nor changes it", async () => {
    const definitionId = (await upsertDefinition(db, randomBytes(32), "t1", { name: "pa", label: "PA", persona: "p" })).id;
    const a = toolsOf(learningsMcpServer({ db }, { tenantId: "t1", definitionId, chatId: "c1", personId: ann }, true));
    const b = toolsOf(learningsMcpServer({ db }, { tenantId: "t1", definitionId, chatId: "c2", personId: bob }, true));
    await a.learn.handler({ text: "My wife is Jo" });
    const shared = await addLearning(db, "t1", { definitionId, text: "Sign off with Cheers", taughtByPersonId: bob });
    const [mine] = (await listLearnings(db, "t1", definitionId, ann)).filter((l) => l.ownerPersonId === ann);
    expect((await listLearnings(db, "t1", definitionId, bob)).map((l) => l.text)).toEqual(["Sign off with Cheers"]);
    expect((await b.learnings.handler({})).content[0]!.text).not.toContain("Jo");
    for (const call of [b.update_learning.handler({ id: mine!.id, text: "x" }), b.forget.handler({ id: mine!.id })]) expect((await call).isError).toBe(true);
    expect((await listLearnings(db, "t1", definitionId, ann)).map((l) => l.text)).toEqual(["My wife is Jo", "Sign off with Cheers"]);
    expect(learningsNote(await listLearnings(db, "t1", definitionId, ann))).toMatch(/- My wife is Jo\n- Sign off with Cheers$/);
    expect(learningsNote([])).toBe("");
    expect(shared.ownerPersonId).toBeNull();
  });

  it("remembers detail in long-term memory and recalls it on demand", async () => {
    const definitionId = (await upsertDefinition(db, randomBytes(32), "t1", { name: "recall", label: "Recall", persona: "p" })).id;
    const t = toolsOf(learningsMcpServer({ db }, { tenantId: "t1", definitionId, chatId: "c1", personId: ann }, false));
    const remembered = await t.remember!.handler({ text: "BE Voice: check the SIP trunk registration first", kind: "procedure", importance: 5 });
    expect(remembered.isError).toBeUndefined();
    expect(remembered.content[0]!.text).toMatch(/^Remembered as /);
    const recalled = await t.recall!.handler({ query: "SIP trunk" });
    expect(recalled.content[0]!.text).toContain("SIP trunk registration");
    const [memory] = await listAllMemory(db, "t1", definitionId);
    expect(memory!.useCount).toBeGreaterThan(0);
  });

  it(`stops at ${MAX_LEARNINGS} learnings per bot`, async () => {
    const definitionId = (await upsertDefinition(db, randomBytes(32), "t1", { name: "full", label: "Full", persona: "p" })).id;
    for (let i = 0; i < MAX_LEARNINGS; i++) await addLearning(db, "t1", { definitionId, text: `rule ${i}`, taughtByPersonId: ann });
    const t = toolsOf(learningsMcpServer({ db }, { tenantId: "t1", definitionId, chatId: "c1", personId: ann }, false));
    expect((await t.learn.handler({ text: "one more" })).isError).toBe(true);
  });
});
