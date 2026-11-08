import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { upsertDefinition } from "../bots/definitions.js";
import { definitionConnections } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { setRole } from "../org/directory.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { ensureBeHubConnection } from "./be-hub.js";
import { getConnection } from "./store.js";

describe("be-hub connection", () => {
  it("creates one MCP connection, links the IT Support bot and keeps read tools free", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: "t1" });
    const admin = await upsertPerson(db, { tenantId: "t1", aadObjectId: "u1", name: "Ann" });
    await setRole(db, "t1", admin.id, "admin");
    const bot = await upsertDefinition(db, Buffer.alloc(32, 1), "t1", { name: "it-support", label: "IT Support", persona: "p" });
    await ensureBeHubConnection(db, Buffer.alloc(32, 2), "t1", { url: "https://behub.example/mcp", apiKey: "bek_test" });
    const c = await getConnection(db, "t1", "be-hub");
    expect(c).toMatchObject({ kind: "mcp", target: "https://behub.example/mcp", mode: "change", status: "active" });
    expect(c!.config).toMatchObject({ headerName: "Authorization", readOnlyTools: expect.arrayContaining(["list_machines", "fleet_summary"]) });
    expect((await db.select().from(definitionConnections).where(eq(definitionConnections.connectionId, c!.id))).map((l) => l.definitionId)).toEqual([bot.id]);
    await ensureBeHubConnection(db, Buffer.alloc(32, 2), "t1", { url: "https://behub.example/mcp", apiKey: "bek_test" });
  });
});
