import { describe, expect, it, vi } from "vitest";
import { testDb } from "../db/test-db.js";
import { upsertChat, upsertTenant } from "../org/org.js";
import { assignToChat, botDefinitionInput, definitionsForChat, mcpServerConfigs, upsertDefinition } from "./definitions.js";

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

  it("rejects an http MCP server without a url and a stdio one without a command", () => {
    const base = { name: "a", label: "A", persona: "p" };
    expect(botDefinitionInput.safeParse({ ...base, mcpServers: [{ name: "x", transport: "http" }] }).success).toBe(false);
    expect(botDefinitionInput.safeParse({ ...base, mcpServers: [{ name: "x", transport: "stdio" }] }).success).toBe(false);
    expect(botDefinitionInput.safeParse({ ...base, mcpServers: [{ name: "x", transport: "stdio", command: "run" }] }).success).toBe(true);
  });

  it("rejects the reserved server name computer", () => {
    const r = botDefinitionInput.safeParse({ name: "a", label: "A", persona: "p", mcpServers: [{ name: "computer", transport: "http", url: "https://x.test/" }] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error)).toContain("is a reserved name");
  });

  it("rejects a server name containing __", () => {
    const r = botDefinitionInput.safeParse({ name: "a", label: "A", persona: "p", mcpServers: [{ name: "a__b", transport: "http", url: "https://x.test/" }] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error)).toContain("a__b");
  });

  it("builds a stdio server config and refuses a record without its command", async () => {
    const db = await testDb();
    const key = Buffer.alloc(32, 3);
    await upsertTenant(db, { id: "t1" });
    const def = await upsertDefinition(db, key, "t1", {
      name: "s", label: "S", persona: "p",
      mcpServers: [{ name: "local", transport: "stdio", command: "run-mcp", args: ["--x"] }],
    });
    vi.stubEnv("SECRETS_KEY", "x");
    vi.stubEnv("PATH", "/usr/bin");
    vi.stubEnv("HOME", "/root");
    const configs = mcpServerConfigs(def, key);
    vi.unstubAllEnvs();
    expect(configs).toEqual({ local: { type: "stdio", command: "run-mcp", args: ["--x"], env: { PATH: "/usr/bin", HOME: "/root" } } });
    const broken = { ...def, mcpServers: [{ name: "local", transport: "stdio" as const, readOnlyTools: [] }] };
    expect(() => mcpServerConfigs(broken, key)).toThrow("MCP server local has no command");
  });
});
