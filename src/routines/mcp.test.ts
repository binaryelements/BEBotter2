import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { assignToChat, upsertDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { testDb } from "../db/test-db.js";
import { upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { routineMcpServer } from "./mcp.js";
import { createRoutine, deleteRoutine, listRoutines } from "./store.js";

type Handler = (args: Record<string, string>) => Promise<{ isError?: boolean; content: { text: string }[] }>;
const toolsOf = (s: ReturnType<typeof routineMcpServer>) => (s.instance as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;

describe("routine mcp", () => {
  let db: Db;
  let ctx: { tenantId: string; definitionId: string; chatId: string; personId: string };
  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: "t1" });
    const definitionId = (await upsertDefinition(db, randomBytes(32), "t1", { name: "ops", label: "Ops", persona: "p" })).id;
    await upsertChat(db, { id: "c1", tenantId: "t1", conversationType: "groupChat" });
    await assignToChat(db, "c1", definitionId);
    const personId = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "a1", name: "Ann" })).id;
    ctx = { tenantId: "t1", definitionId, chatId: "c1", personId };
  });

  it("remind creates a one-off routine for this chat and refuses past times", async () => {
    const t = toolsOf(routineMcpServer({ db }, ctx));
    expect(Object.keys(t)).toEqual(["remind", "reminders", "cancel_reminder", "background"]);
    const at = new Date(Date.now() + 3600_000).toISOString();
    expect((await t.remind.handler({ at, prompt: "call back" })).isError).toBeUndefined();
    const [r] = await listRoutines(db, "t1");
    expect(r).toMatchObject({ chatId: "c1", prompt: "call back", schedule: null, createdByPersonId: ctx.personId });
    expect(r.runAt?.toISOString()).toBe(at);
    for (const bad of [new Date(Date.now() - 1000).toISOString(), "2099-01-01T00:00:00Z", at.replace("Z", ""), "tomorrow"])
      expect((await t.remind.handler({ at: bad, prompt: "x" })).isError).toBe(true);
    expect(await listRoutines(db, "t1")).toHaveLength(1);
  });

  it("background starts a job now for this chat, three at most waiting", async () => {
    const t = toolsOf(routineMcpServer({ db }, ctx));
    expect((await t.background.handler({ task: "compare MEL-MNL fares on 11 Nov" })).isError).toBeUndefined();
    const job = (await listRoutines(db, "t1")).find((r) => r.background)!;
    expect(job).toMatchObject({ chatId: "c1", prompt: "compare MEL-MNL fares on 11 Nov", schedule: null, enabled: true, createdByPersonId: ctx.personId });
    expect(job.runAt!.getTime() - Date.now()).toBeLessThan(5000);
    await t.background.handler({ task: "b" });
    await t.background.handler({ task: "c" });
    expect((await t.background.handler({ task: "d" })).isError).toBe(true);
    expect((await listRoutines(db, "t1")).filter((r) => r.background)).toHaveLength(3);
  });

  it("post exists only when a post callback is given, and then background does not", async () => {
    const posted: string[] = [];
    const t = toolsOf(routineMcpServer({ db }, { ...ctx, post: async (x) => void posted.push(x) }));
    expect(Object.keys(t)).toEqual(["remind", "reminders", "cancel_reminder", "post"]);
    await t.post.handler({ text: "hi" });
    expect(posted).toEqual(["hi"]);
  });

  it("lists and cancels this chat's waiting one-offs, never another chat's or a recurring routine", async () => {
    const t = toolsOf(routineMcpServer({ db }, ctx));
    const runAt = new Date(Date.now() + 3600_000);
    const mine = await createRoutine(db, "t1", { definitionId: ctx.definitionId, chatId: "c1", prompt: "check calendar", runAt, createdByPersonId: ctx.personId });
    await upsertChat(db, { id: "c2", tenantId: "t1", conversationType: "groupChat" });
    await assignToChat(db, "c2", ctx.definitionId);
    const other = await createRoutine(db, "t1", { definitionId: ctx.definitionId, chatId: "c2", prompt: "elsewhere", runAt, createdByPersonId: ctx.personId });
    const cron = await createRoutine(db, "t1", { definitionId: ctx.definitionId, chatId: "c1", prompt: "daily", schedule: "0 9 * * *", createdByPersonId: ctx.personId });
    const listed = (await t.reminders.handler({})).content[0]!.text;
    expect(listed).toContain(mine.id);
    expect(listed).not.toContain(other.id);
    expect(listed).not.toContain(cron.id);
    for (const id of [other.id, cron.id]) expect((await t.cancel_reminder.handler({ id })).isError).toBe(true);
    expect((await t.cancel_reminder.handler({ id: mine.id })).isError).toBeUndefined();
    const left = (await listRoutines(db, "t1")).map((r) => r.id);
    expect(left).not.toContain(mine.id);
    expect(left).toEqual(expect.arrayContaining([other.id, cron.id]));
    for (const r of [other, cron]) await deleteRoutine(db, "t1", r.id);
  });

  it("remind refuses past 50 pending reminders in the chat", async () => {
    const t = toolsOf(routineMcpServer({ db }, ctx));
    const runAt = new Date(Date.now() + 3600_000);
    while ((await listRoutines(db, "t1")).length < 50) await createRoutine(db, "t1", { definitionId: ctx.definitionId, chatId: "c1", prompt: "x", runAt, createdByPersonId: ctx.personId });
    const r = await t.remind.handler({ at: runAt.toISOString(), prompt: "one more" });
    expect(r.isError).toBe(true);
    expect(await listRoutines(db, "t1")).toHaveLength(50);
  });
});
