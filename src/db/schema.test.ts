import { describe, expect, it } from "vitest";
import { testDb } from "./test-db.js";
import { tenants, people } from "./schema.js";

describe("schema", () => {
  it("creates the tables and enforces the person uniqueness", async () => {
    const db = await testDb();
    await db.insert(tenants).values({ id: "t1", name: "Example" });
    await db.insert(people).values({ id: "p1", tenantId: "t1", aadObjectId: "a1", name: "Ann" });
    await expect(
      db.insert(people).values({ id: "p2", tenantId: "t1", aadObjectId: "a1", name: "Ann again" }),
    ).rejects.toThrow();
  });
});
