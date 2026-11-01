import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { mayUseDefinition } from "../admin/access.js";
import { botDefinitions, chats, people, tenants } from "../db/schema.js";
import { testDb } from "../db/test-db.js";
import { upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { createDepartment } from "../org/directory.js";
import { mcpServerInput, addMcpServer, allowedDepartments, assignToChat, botDefinitionInput, ensurePersonalDefinition, definitionsForChat, getDefinition, mcpServerConfigs, removeMcpServer, setAllowedDepartments, setChatDefinition, usableDefinitions, updateDefinitionFields, upsertDefinition } from "./definitions.js";

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

describe("the Personal definition", () => {
  it("is created once per tenant, even when ensured twice at the same time", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: "t1" });
    const [a, b] = await Promise.all([ensurePersonalDefinition(db, "t1", "m"), ensurePersonalDefinition(db, "t1", "m")]);
    expect(a.id).toBe(b.id);
    expect((await db.select().from(botDefinitions).where(eq(botDefinitions.name, "personal"))).length).toBe(1);
    expect(a).toMatchObject({ label: "My assistant", identity: "person", computer: false });
    expect(a.graph).toHaveLength(7);
  });

  it("takes the tenant default model, else the one passed in", async () => {
    const db = await testDb();
    await db.insert(tenants).values({ id: "t2", name: "", defaultModel: "m-tenant" });
    expect((await ensurePersonalDefinition(db, "t2", "m-config")).model).toBe("m-tenant");
    await db.insert(tenants).values({ id: "t3", name: "" });
    expect((await ensurePersonalDefinition(db, "t3", "m-config")).model).toBe("m-config");
  });

  it("reads rows saved before identity existed as service", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: "t1" });
    await db.execute(sql`insert into bot_definitions (id, tenant_id, name, label, persona, model, web_search, computer, mcp_servers) values ('old', 't1', 'old', 'Old', 'p', 'm', false, false, '[]'::jsonb)`);
    expect(await getDefinition(db, "t1", "old")).toMatchObject({ identity: "service", graph: [] });
  });

  it("refuses to adopt a service bot that already took the name", async () => {
    const db = await testDb();
    await upsertDefinition(db, Buffer.alloc(32), "t1", { name: "personal", label: "Mine", persona: "p" });
    await expect(ensurePersonalDefinition(db, "t1", "m")).rejects.toThrow(/already exists/);
  });

  it("is usable only by people with the flag on", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: "t1" });
    const def = await ensurePersonalDefinition(db, "t1", "m");
    const p = await upsertPerson(db, { tenantId: "t1", aadObjectId: "a", name: "A" });
    expect(await mayUseDefinition(db, "t1", p.id, def.id)).toBe(false);
    await db.update(people).set({ personalBot: true }).where(eq(people.id, p.id));
    expect(await mayUseDefinition(db, "t1", p.id, def.id)).toBe(true);
  });

  it("is assigned only to a one-to-one chat whose owner has the flag", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: "t1" });
    const def = await ensurePersonalDefinition(db, "t1", "m");
    const p = await upsertPerson(db, { tenantId: "t1", aadObjectId: "a", name: "A" });
    await upsertChat(db, { id: "g", tenantId: "t1", conversationType: "groupChat" });
    await upsertChat(db, { id: "dm", tenantId: "t1", conversationType: "personal" });
    await expect(assignToChat(db, "g", def.id)).rejects.toThrow(/one-to-one/);
    await db.update(chats).set({ ownerPersonId: p.id }).where(eq(chats.id, "dm"));
    await expect(assignToChat(db, "dm", def.id)).rejects.toThrow(/no personal assistant/);
    await db.update(people).set({ personalBot: true }).where(eq(people.id, p.id));
    await assignToChat(db, "dm", def.id);
    expect((await definitionsForChat(db, "dm")).map((d) => d.id)).toEqual([def.id]);
  });

  it("setChatDefinition refuses Personal on a group chat and leaves the assignment alone", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: "t1" });
    const def = await ensurePersonalDefinition(db, "t1", "m");
    await upsertChat(db, { id: "g", tenantId: "t1", conversationType: "groupChat" });
    await expect(setChatDefinition(db, "t1", "g", def.id)).rejects.toThrow(/one-to-one/);
    expect(await definitionsForChat(db, "g")).toEqual([]);
  });

  it("usableDefinitions lets an unexpected error from creating Personal propagate", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: "t1" });
    const p = await upsertPerson(db, { tenantId: "t1", aadObjectId: "a", name: "A" });
    await db.update(people).set({ personalBot: true }).where(eq(people.id, p.id));
    const broken = Object.assign(Object.create(db), { insert: () => { throw new Error("db down"); } });
    await expect(usableDefinitions(broken, "t1", p.id, "m")).rejects.toThrow("db down");
  });
});
