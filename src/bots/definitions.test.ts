import { describe, expect, it, vi } from "vitest";
import { tenants } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { upsertChat, upsertTenant } from "../org/org.js";
import { createDepartment } from "../org/directory.js";
import { mcpServerInput, addMcpServer, allowedDepartments, assignToChat, botDefinitionInput, definitionsForChat, getDefinition, mcpServerConfigs, removeMcpServer, setAllowedDepartments, updateDefinitionFields, upsertDefinition } from "./definitions.js";

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

  it("creates the tenant row when the tenant is not known yet", async () => {
    const db = await testDb();
    await upsertDefinition(db, Buffer.alloc(32, 3), "fresh", { name: "a", label: "A", persona: "one" });
    expect((await db.select().from(tenants)).map((t) => t.id)).toEqual(["fresh"]);
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

describe("bot definition admin helpers", () => {
  it("setAllowedDepartments replaces the links and ignores other tenants' departments", async () => {
    const db = await testDb();
    const key = Buffer.alloc(32, 3);
    await upsertTenant(db, { id: "t1" });
    await upsertTenant(db, { id: "t2" });
    const a = (await createDepartment(db, "t1", "A")).id;
    const b = (await createDepartment(db, "t1", "B")).id;
    const other = (await createDepartment(db, "t2", "Other")).id;
    const def = await upsertDefinition(db, key, "t1", { name: "x", label: "X", persona: "p" });
    await setAllowedDepartments(db, "t1", def.id, [a, other]);
    expect(await allowedDepartments(db, def.id)).toEqual([a]);
    await setAllowedDepartments(db, "t1", def.id, [b]);
    expect(await allowedDepartments(db, def.id)).toEqual([b]);
  });

  it("adding and removing a server leaves the other servers' ciphertext alone and rejects duplicates", async () => {
    const db = await testDb();
    const key = Buffer.alloc(32, 3);
    await upsertTenant(db, { id: "t1" });
    const def = await upsertDefinition(db, key, "t1", {
      name: "x", label: "X", persona: "p",
      mcpServers: [{ name: "one", transport: "http", url: "https://a.test/", headers: { A: "b" } }],
    });
    const before = def.mcpServers[0].headersCipher;
    await addMcpServer(db, key, "t1", def.id, { name: "two", transport: "stdio", command: "run", readOnlyTools: [] });
    await expect(addMcpServer(db, key, "t1", def.id, { name: "two", transport: "stdio", command: "run", readOnlyTools: [] })).rejects.toThrow(/already/);
    await expect(addMcpServer(db, key, "t1", def.id, { name: "computer", transport: "stdio", command: "run", readOnlyTools: [] })).rejects.toThrow(/reserved/);
    let cur = (await getDefinition(db, "t1", def.id))!;
    expect(cur.mcpServers.map((s) => s.name)).toEqual(["one", "two"]);
    expect(cur.mcpServers[0].headersCipher).toBe(before);
    await removeMcpServer(db, "t1", def.id, "two");
    cur = (await getDefinition(db, "t1", def.id))!;
    expect(cur.mcpServers.map((s) => s.name)).toEqual(["one"]);
    expect(cur.mcpServers[0].headersCipher).toBe(before);
    await updateDefinitionFields(db, "t1", def.id, { label: "Y", persona: "q", model: "m", webSearch: true, computer: true });
    cur = (await getDefinition(db, "t1", def.id))!;
    expect([cur.label, cur.persona, cur.model, cur.webSearch, cur.computer, cur.mcpServers[0].headersCipher]).toEqual(["Y", "q", "m", true, true, before]);
    expect(await getDefinition(db, "t2", def.id)).toBeUndefined();
  });
});

describe("reserved MCP names", () => {
  it("are refused", () => {
    for (const name of ["knowledge", "connections", "routine", "computer", "conn-x", "Knowledge", "COMPUTER", "Conn-x"]) {
      const r = mcpServerInput.safeParse({ name, transport: "http", url: "https://example.com/mcp" });
      expect(r.success, name).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain("reserved");
    }
    expect(mcpServerInput.safeParse({ name: "docs", transport: "http", url: "https://example.com/mcp" }).success).toBe(true);
  });

  it("saved servers with a reserved name are skipped at runtime", async () => {
    const db = await testDb();
    const key = Buffer.alloc(32, 3);
    await upsertTenant(db, { id: "t1" });
    const def = await upsertDefinition(db, key, "t1", { name: "b", label: "B", persona: "p", mcpServers: [{ name: "docs", transport: "stdio", command: "run" }] });
    const legacy = { ...def, mcpServers: ["knowledge", "Routine", "conn-x", "docs"].map((name) => ({ name, transport: "stdio" as const, command: "run", readOnlyTools: [] })) };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(Object.keys(mcpServerConfigs(legacy, key))).toEqual(["docs"]);
    expect(errors).toHaveBeenCalledTimes(3);
    errors.mockRestore();
  });
});
