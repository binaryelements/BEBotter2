import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import type { Person } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { setPersonalBot } from "../org/directory.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { ensurePersonalAssistant } from "../bots/definitions.js";
import { todoMcpServer } from "./mcp.js";

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;
const toolsOf = (s: ReturnType<typeof todoMcpServer>) => (s.instance as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;

describe("todo tools", () => {
  let db: Db;
  let ann: Person;
  let pa: string;
  const server = () => toolsOf(todoMcpServer({ db }, { tenantId: "t1", definitionId: pa, personId: ann.id }));

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: "t1" });
    ann = await upsertPerson(db, { tenantId: "t1", aadObjectId: "u1", name: "Ann" });
    await setPersonalBot(db, "t1", ann.id, true);
    pa = (await ensurePersonalAssistant(db, "t1", ann.id, "m")).id;
  });

  it("adds, lists and completes the owner's to-dos", async () => {
    const t = server();
    const added = await t.add_todo.handler({ title: "Send the report", dueAt: "2026-11-10" });
    expect(added.isError).toBeUndefined();
    expect(added.content[0].text).toContain("Added #");
    const id = /#([0-9a-f-]+)/.exec(added.content[0].text)![1];
    expect((await t.list_todos.handler({ status: "open" })).content[0].text).toContain("Send the report");
    expect((await t.complete_todo.handler({ id })).content[0].text).toContain("Done");
    expect((await t.list_todos.handler({ status: "open" })).content[0].text).toBe("No to-dos are open.");
  });
});
