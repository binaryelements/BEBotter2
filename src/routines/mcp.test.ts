import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { assignToChat, upsertDefinition } from "../bots/definitions.js";
import type { Db } from "../db/client.js";
import { testDb } from "../db/test-db.js";
import { upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { routineMcpServer } from "./mcp.js";
import { listRoutines } from "./store.js";

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
    expect(Object.keys(t)).toEqual(["remind"]);
    const at = new Date(Date.now() + 3600_000).toISOString();
    expect((await t.remind.handler({ at, prompt: "call back" })).isError).toBeUndefined();
    const [r] = await listRoutines(db, "t1");
    expect(r).toMatchObject({ chatId: "c1", prompt: "call back", schedule: null, createdByPersonId: ctx.personId });
    expect(r.runAt?.toISOString()).toBe(at);
    for (const bad of [new Date(Date.now() - 1000).toISOString(), "2099-01-01T00:00:00Z", at.replace("Z", ""), "tomorrow"])
      expect((await t.remind.handler({ at: bad, prompt: "x" })).isError).toBe(true);
    expect(await listRoutines(db, "t1")).toHaveLength(1);
  });

  it("post exists only when a post callback is given", async () => {
    const posted: string[] = [];
    const t = toolsOf(routineMcpServer({ db }, { ...ctx, post: async (x) => void posted.push(x) }));
    await t.post.handler({ text: "hi" });
    expect(posted).toEqual(["hi"]);
  });
});
