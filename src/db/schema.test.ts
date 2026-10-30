import { describe, expect, it } from "vitest";
import { testDb } from "./test-db.js";
import { eq } from "drizzle-orm";
import { tenants, people, botDefinitions, departments, departmentMembers, definitionDepartments } from "./schema.js";

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
});
