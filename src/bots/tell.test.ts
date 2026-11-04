import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { Db } from "../db/client.js";
import type { Person } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { createDepartment, setPersonalBot, setRole } from "../org/directory.js";
import { recordChatOwner, upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { ensurePersonalDefinition, setAllowedDepartments, upsertDefinition } from "./definitions.js";
import { tellMcpServer } from "./tell.js";
import type { TellRun } from "./tell.js";

type Handler = (args: Record<string, string>) => Promise<{ isError?: boolean; content: { text: string }[] }>;
const toolsOf = (s: ReturnType<typeof tellMcpServer>) => (s.instance as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;

describe("tell_bot", () => {
  let db: Db;
  let ann: Person;
  let it_: string;
  let finance: string;
  let personal: string;
  const run = vi.fn<TellRun>(async (t) => ({ text: `${t.definition.label} did: ${t.text.split("\n\n")[1]}` }));
  const server = (definitionId: string, over: Partial<Parameters<typeof tellMcpServer>[1]> = {}, deps: Partial<Parameters<typeof tellMcpServer>[0]> = {}) =>
    toolsOf(tellMcpServer({ db, run, ...deps }, { tenantId: "t1", chatId: "c1", definitionId, person: ann, relay: 0, askConfirmation: async () => {}, ...over }));

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: "t1" });
    ann = await upsertPerson(db, { tenantId: "t1", aadObjectId: "u1", name: "Ann" });
    const key = randomBytes(32);
    it_ = (await upsertDefinition(db, key, "t1", { name: "it", label: "IT Support", displayName: "Mickey", persona: "p" } as never)).id;
    finance = (await upsertDefinition(db, key, "t1", { name: "finance", label: "Finance", persona: "p" } as never)).id;
    personal = (await ensurePersonalDefinition(db, "t1", "m")).id;
    await upsertChat(db, { id: "c1", tenantId: "t1", conversationType: "personal" });
    await recordChatOwner(db, "c1", ann.id);
  });

  it("passes the message to the named bot as the same person and hands back its reply", async () => {
    const t = server(finance);
    const r = await t.tell_bot.handler({ bot: "mickey", message: "The printer on level 2 is jammed; please fix it." });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe("Mickey · IT Support replied:\nIT Support did: The printer on level 2 is jammed; please fix it.");
    const call = run.mock.calls[0]![0];
    expect(call).toMatchObject({ tenantId: "t1", chatId: "c1", person: { id: ann.id }, relay: 1 });
    expect(call.definition.id).toBe(it_);
    expect(call.text.startsWith("[Finance passes this on for Ann.")).toBe(true);
    expect(call.graphToken).toBeUndefined();
  });

  it("names the reachable bots when the name is unknown, and refuses a bot the person may not use", async () => {
    const sales = await createDepartment(db, "t1", "Sales");
    await setAllowedDepartments(db, "t1", finance, [sales.id]);
    const t = server(it_);
    const r = await t.tell_bot.handler({ bot: "Jennifer", message: "hi" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('No bot called "Jennifer". Ann can reach no other bot');
    expect((await t.tell_bot.handler({ bot: "finance", message: "hi" })).content[0].text).toBe("Ann can't use Finance, so it can't be told for them.");
    await setAllowedDepartments(db, "t1", finance, []);
  });

  it("a told bot cannot tell further", async () => {
    const r = await server(finance, { relay: 1 }).tell_bot.handler({ bot: "Mickey", message: "hi" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("can't pass it on");
  });

  it("a person's assistant is told only in the owner's own chat, with their kept sign-in", async () => {
    await setPersonalBot(db, "t1", ann.id, true);
    await setRole(db, "t1", ann.id, "admin");
    const noToken = server(it_, {}, { personToken: async () => undefined });
    expect((await noToken.tell_bot.handler({ bot: "My assistant", message: "note this" })).content[0].text).toContain("must sign in");
    run.mockClear();
    const t = server(it_, {}, { personToken: async () => "tok" });
    const r = await t.tell_bot.handler({ bot: "My assistant", message: "note this" });
    expect(r.isError).toBeUndefined();
    expect(run.mock.calls[0]![0].definition.id).toBe(personal);
    expect(await run.mock.calls[0]![0].graphToken!()).toBe("tok");
    await upsertChat(db, { id: "g1", tenantId: "t1", conversationType: "groupChat" });
    const group = server(it_, { chatId: "g1" }, { personToken: async () => "tok" });
    expect((await group.tell_bot.handler({ bot: "My assistant", message: "note this" })).content[0].text).toContain("private to its owner");
  });
});
