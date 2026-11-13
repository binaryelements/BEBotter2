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
import { listTodos } from "../todos/store.js";

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

  it("sends a request to another person's assistant, which waits for the owner", async () => {
    const a = server(annPa, ann);
    const r = await a.ask_assistant.handler({ to: "Bob", request: "Check whether Friday works for the review.", kind: "request" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Bob's assistant");
    expect(r.content[0].text).toContain("ask Bob");
    const [row] = await db.select().from(assistantRequests).where(eq(assistantRequests.tenantId, "t1"));
    expect(row).toMatchObject({ fromDefinitionId: annPa, toDefinitionId: bobPa, fromPersonId: ann.id, toPersonId: bob.id, kind: "request", status: "pending" });
    const b = server(bobPa, bob);
    const list = await b.my_requests.handler({});
    expect(list.content[0].text).toContain("from Ann (request): Check whether Friday works");
    const done = await b.resolve_request.handler({ id: row.id, accept: true });
    expect(done.content[0].text).toContain("Accepted");
    const [after] = await db.select().from(assistantRequests).where(eq(assistantRequests.id, row.id));
    expect(after.status).toBe("accepted");
  });

  it("auto-accepts a low-risk todo and puts it on the recipient's list", async () => {
    const a = server(annPa, ann);
    const r = await a.ask_assistant.handler({ to: "Bob", request: "Send the October report to Priya by Friday.", kind: "todo", dueAt: "2026-11-10" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Added to Bob's to-dos");
    const rows = await db.select().from(assistantRequests).where(eq(assistantRequests.tenantId, "t1")).orderBy(assistantRequests.createdAt);
    const row = rows[rows.length - 1];
    expect(row).toMatchObject({ fromDefinitionId: annPa, toDefinitionId: bobPa, kind: "todo", status: "accepted" });
    const { listTodos } = await import("../todos/store.js");
    const todos = await listTodos(db, "t1", bob.id);
    expect(todos.map((t) => t.title)).toContain("Send the October report to Priya by Friday.");
  });

  it("finds a person by their assistant's name, or by a first name that only one person has", async () => {
    // Jasmine is Bob's assistant; asking Jasmine is asking Bob
    const { botDefinitions } = await import("../db/schema.js");
    await db.update(botDefinitions).set({ displayName: "Jasmine" }).where(eq(botDefinitions.id, bobPa));
    const a = server(annPa, ann);
    const byName = await a.ask_assistant.handler({ to: "Jasmine", request: "Book the review room for Friday." });
    expect(byName.isError).toBeUndefined();
    expect(byName.content[0].text).toContain("Bob's assistant");

    // "Pat" for Pat Smith, when nobody else starts with it
    const pat = await upsertPerson(db, { tenantId: "t1", aadObjectId: "u9", name: "Pat Smith" });
    await setPersonalBot(db, "t1", pat.id, true);
    await ensurePersonalAssistant(db, "t1", pat.id, "m");
    const byFirst = await a.ask_assistant.handler({ to: "Pat", request: "Check the D1 invoices." });
    expect(byFirst.isError).toBeUndefined();
    expect(byFirst.content[0].text).toContain("Pat Smith's assistant");

    const unknown = await a.ask_assistant.handler({ to: "Nobody", request: "hi" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("No person or assistant called");
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
