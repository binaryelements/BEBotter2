import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { upsertDefinition } from "../bots/definitions.js";
import { definitionConnections } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { setRole } from "../org/directory.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { ensureMantisConnection } from "./mantis.js";
import { getConnection } from "./store.js";

describe("mantis connection", () => {
  it("creates one MCP connection, links the IT Support bot and keeps line_show free", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: "t1" });
    const admin = await upsertPerson(db, { tenantId: "t1", aadObjectId: "u1", name: "Ann" });
    await setRole(db, "t1", admin.id, "admin");
    const bot = await upsertDefinition(db, Buffer.alloc(32, 1), "t1", { name: "it-support", label: "IT Support", persona: "p" });
    await ensureMantisConnection(db, Buffer.alloc(32, 2), "t1", { url: "https://mantis.example/mcp", secret: "Basic test" });
    const c = await getConnection(db, "t1", "mantis");
    expect(c).toMatchObject({ kind: "mcp", target: "https://mantis.example/mcp", mode: "change", status: "active" });
    expect(c!.config).toMatchObject({ headerName: "Authorization", readOnlyTools: ["line_show"] });
    expect((await db.select().from(definitionConnections).where(eq(definitionConnections.connectionId, c!.id))).map((l) => l.definitionId)).toEqual([bot.id]);
    await ensureMantisConnection(db, Buffer.alloc(32, 2), "t1", { url: "https://mantis.example/mcp", secret: "Basic test" });
  });
});
