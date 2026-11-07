import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { Person } from "../db/schema.js";
import { assistantRequests } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { setPersonalBot } from "../org/directory.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { ensurePersonalAssistant, upsertDefinition } from "./definitions.js";
import { assistantMcpServer } from "./assistant.js";

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;
const toolsOf = (s: ReturnType<typeof assistantMcpServer>) => (s.instance as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;

describe("assistant requests", () => {
  let db: Db;
  let ann: Person;
  let bob: Person;
  let annPa: string;
  let bobPa: string;
  const server = (definitionId: string, person: Person) => toolsOf(assistantMcpServer({ db }, { tenantId: "t1", definitionId, personId: person.id, person }));

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: "t1" });
    ann = await upsertPerson(db, { tenantId: "t1", aadObjectId: "u1", name: "Ann" });
    bob = await upsertPerson(db, { tenantId: "t1", aadObjectId: "u2", name: "Bob" });
    await setPersonalBot(db, "t1", ann.id, true);
    await setPersonalBot(db, "t1", bob.id, true);
    annPa = (await ensurePersonalAssistant(db, "t1", ann.id, "m")).id;
    bobPa = (await ensurePersonalAssistant(db, "t1", bob.id, "m")).id;
  });

  it("sends a request to another person's assistant and lists it for the owner", async () => {
    const a = server(annPa, ann);
    const r = await a.ask_assistant.handler({ to: "Bob", request: "Add a to-do: send the report by Friday.", kind: "todo" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Bob's assistant");
    const [row] = await db.select().from(assistantRequests).where(eq(assistantRequests.tenantId, "t1"));
    expect(row).toMatchObject({ fromDefinitionId: annPa, toDefinitionId: bobPa, fromPersonId: ann.id, toPersonId: bob.id, kind: "todo", status: "pending" });
    const b = server(bobPa, bob);
    const list = await b.my_requests.handler({});
    expect(list.content[0].text).toContain("from Ann (todo): Add a to-do");
    const done = await b.resolve_request.handler({ id: row.id, accept: true });
    expect(done.content[0].text).toContain("Accepted");
    const [after] = await db.select().from(assistantRequests).where(eq(assistantRequests.id, row.id));
    expect(after.status).toBe("accepted");
  });

  it("refuses a person with no assistant, and a service bot", async () => {
    await upsertPerson(db, { tenantId: "t1", aadObjectId: "u3", name: "Carol" });
    const a = server(annPa, ann);
    const r = await a.ask_assistant.handler({ to: "Carol", request: "hi" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("has no personal assistant");
    const service = (await upsertDefinition(db, randomBytes(32), "t1", { name: "it", label: "IT", persona: "p" } as never)).id;
    const s = server(service, ann);
    const no = await s.ask_assistant.handler({ to: "Bob", request: "hi" });
    expect(no.isError).toBe(true);
    expect(no.content[0].text).toContain("Only a personal assistant");
  });
});
