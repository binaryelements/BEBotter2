import { describe, expect, it } from "vitest";
import { testDb } from "./test-db.js";
import { eq } from "drizzle-orm";
import { tenants, people, chats, botDefinitions, departments, departmentMembers, definitionDepartments, connections, secretLinks, definitionConnections, knowledgeVersions, routines } from "./schema.js";

describe("schema", () => {
  it("creates the tables and enforces the person uniqueness", async () => {
    const db = await testDb();
    await db.insert(tenants).values({ id: "t1", name: "Example" });
    await db.insert(people).values({ id: "p1", tenantId: "t1", aadObjectId: "a1", name: "Ann" });
    await expect(
      db.insert(people).values({ id: "p2", tenantId: "t1", aadObjectId: "a1", name: "Ann again" }),
    ).rejects.toThrow();
  });

  it("links people and bot definitions to departments, cascading on delete", async () => {
    const db = await testDb();
    await db.insert(tenants).values({ id: "t1", name: "Example" });
    await db.insert(people).values({ id: "p1", tenantId: "t1", aadObjectId: "a1", name: "Ann" });
    const [p] = await db.select().from(people);
    expect(p!.role).toBe("user");
    expect(p!.personalBot).toBe(false);
    await db.insert(botDefinitions).values({
      id: "d1", tenantId: "t1", name: "bot", label: "Bot", persona: "x", model: "m", webSearch: false, computer: false, mcpServers: [],
    });
    await db.insert(departments).values({ id: "dep1", tenantId: "t1", name: "Sales" });
    await db.insert(departmentMembers).values({ departmentId: "dep1", personId: "p1" });
    await db.insert(definitionDepartments).values({ definitionId: "d1", departmentId: "dep1" });
    await expect(db.insert(departments).values({ id: "dep2", tenantId: "t1", name: "Sales" })).rejects.toThrow();
    await db.delete(departments).where(eq(departments.id, "dep1"));
    expect(await db.select().from(departmentMembers)).toEqual([]);
    expect(await db.select().from(definitionDepartments)).toEqual([]);
  });

  it("plan 3 tables exist after migrations", async () => {
    const db = await testDb();
    await db.insert(tenants).values({ id: "t1", name: "Example" });
    expect((await db.select().from(tenants))[0]!.timezone).toBe("UTC");
    await db.insert(people).values({ id: "p1", tenantId: "t1", aadObjectId: "a1", name: "Ann" });
    await db.insert(chats).values({ id: "c1", tenantId: "t1", conversationType: "personal" });
    await db.insert(botDefinitions).values({
      id: "d1", tenantId: "t1", name: "bot", label: "Bot", persona: "x", model: "m", webSearch: false, computer: false, mcpServers: [],
    });
    await db.insert(connections).values({
      id: "k1", tenantId: "t1", name: "web1", kind: "ssh", target: "host.example", config: { port: 22, username: "ops" },
      mode: "read-only", status: "pending",
    });
    await db.insert(secretLinks).values({
      id: "s1", tenantId: "t1", connectionId: "k1", personId: "p1", tokenHash: "abc", expiresAt: new Date(Date.now() + 1000),
    });
    await db.insert(definitionConnections).values({ definitionId: "d1", connectionId: "k1" });
    await db.insert(knowledgeVersions).values({ id: "n1", tenantId: "t1", path: "a.md", version: 1, bodyCipher: "x" });
    await db.insert(routines).values({ id: "r1", tenantId: "t1", definitionId: "d1", chatId: "c1", prompt: "go", createdByPersonId: "p1" });
    const [k] = await db.select().from(connections);
    expect([k!.secretCipher, k!.publicKey, k!.hostKey]).toEqual([null, null, null]);
    expect((await db.select().from(knowledgeVersions))[0]!.deleted).toBe(false);
    const [r] = await db.select().from(routines);
    expect([r!.quiet, r!.enabled, r!.schedule, r!.runAt]).toEqual([false, true, null, null]);
    expect(await db.select().from(secretLinks)).toHaveLength(1);
    expect(await db.select().from(definitionConnections)).toHaveLength(1);
  });

  it("connection name is unique per tenant", async () => {
    const db = await testDb();
    await db.insert(tenants).values([{ id: "t1", name: "A" }, { id: "t2", name: "B" }]);
    const row = (id: string, tenantId: string) => ({
      id, tenantId, name: "web1", kind: "http", target: "https://example.com", config: {}, mode: "read-only", status: "pending",
    });
    await db.insert(connections).values(row("k1", "t1"));
    await expect(db.insert(connections).values(row("k2", "t1"))).rejects.toThrow();
    await db.insert(connections).values(row("k3", "t2"));
  });
});
