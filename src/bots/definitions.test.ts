import { describe, expect, it } from "vitest";
import { testDb } from "../db/test-db.js";
import { upsertChat, upsertTenant } from "../org/org.js";
import { assignToChat, definitionsForChat, mcpServerConfigs, upsertDefinition } from "./definitions.js";

describe("bot definitions", () => {
  it("stores MCP headers encrypted and gives them back decrypted", async () => {
    const db = await testDb();
    const key = Buffer.alloc(32, 3);
    await upsertTenant(db, { id: "t1" });
    const def = await upsertDefinition(db, key, "t1", {
      name: "it-support",
      label: "IT Support",
      persona: "You help with IT.",
      mcpServers: [
        { name: "tickets", transport: "http", url: "https://mcp.example.test/", headers: { Authorization: "Bearer s3cret" }, readOnlyTools: ["list_tickets"] },
      ],
    });
    expect(JSON.stringify(def)).not.toContain("s3cret");
    expect(mcpServerConfigs(def, key)).toEqual({
      tickets: { type: "http", url: "https://mcp.example.test/", headers: { Authorization: "Bearer s3cret" } },
    });
  });

  it("assigns a definition to a chat and lists it", async () => {
    const db = await testDb();
    const key = Buffer.alloc(32, 3);
    await upsertTenant(db, { id: "t1" });
    await upsertChat(db, { id: "c1", tenantId: "t1", conversationType: "groupChat" });
    const def = await upsertDefinition(db, key, "t1", { name: "a", label: "A", persona: "one" });
    expect(def.model).toBe("claude-haiku-5-5");
    expect(def.webSearch).toBe(false);
    await assignToChat(db, "c1", def.id);
    await assignToChat(db, "c1", def.id);
    expect(await definitionsForChat(db, "c1")).toEqual([def]);
    const again = await upsertDefinition(db, key, "t1", { name: "a", label: "A", persona: "two" });
    expect(again.id).toBe(def.id);
    expect(again.persona).toBe("two");
    expect((await definitionsForChat(db, "c1"))[0].persona).toBe("two");
  });
});
