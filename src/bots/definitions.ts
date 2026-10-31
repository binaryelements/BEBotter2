import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { botDefinitions, chatAssignments, chats, definitionDepartments, departments } from "../db/schema.js";
import type { BotDefinition, McpServerRecord } from "../db/schema.js";
import { DirectoryError } from "../org/directory.js";
import { getTenantSettings, upsertTenant } from "../org/org.js";
import { decrypt, encrypt } from "../secrets/cipher.js";

export const RESERVED_MCP_NAMES = ["computer", "knowledge", "connections", "routine", "mail"] as const;

/** MCP connections attach as `conn-<name>`, so that prefix is reserved too. */
export const isReservedMcpName = (name: string): boolean => (RESERVED_MCP_NAMES as readonly string[]).includes(name.toLowerCase()) || name.toLowerCase().startsWith("conn-");

export const mcpServerInput = z.object({
  name: z.string().min(1),
  transport: z.enum(["http", "stdio"]),
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  readOnlyTools: z.array(z.string()).default([]),
}).superRefine((s, ctx) => {
  const need = s.transport === "http" ? "url" : "command";
  if (isReservedMcpName(s.name)) ctx.addIssue({ code: "custom", path: ["name"], message: `MCP server "${s.name}" is a reserved name` });
  if (s.name.includes("__")) ctx.addIssue({ code: "custom", path: ["name"], message: `MCP server "${s.name}" must not contain "__"` });
  if (!s[need]) ctx.addIssue({ code: "custom", path: [need], message: `${s.transport} MCP server "${s.name}" requires ${need}` });
});

export const botDefinitionInput = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  displayName: z.string().trim().max(60).optional(),
  persona: z.string(),
  model: z.string().optional(),
  webSearch: z.boolean().default(false),
  computer: z.boolean().default(false),
  mcpServers: z.array(mcpServerInput).default([]),
});

export type BotDefinitionInput = z.input<typeof botDefinitionInput>;

export async function upsertDefinition(db: Db, secretsKey: Buffer, tenantId: string, input: BotDefinitionInput): Promise<BotDefinition> {
  const p = botDefinitionInput.parse(input);
  const mcpServers: McpServerRecord[] = p.mcpServers.map(({ headers, ...s }) => ({
    ...s,
    ...(headers && Object.keys(headers).length > 0 ? { headersCipher: encrypt(secretsKey, JSON.stringify(headers)) } : {}),
  }));
  await upsertTenant(db, { id: tenantId }); // the definition row references tenants
  const model = p.model ?? (await getTenantSettings(db, tenantId)).defaultModel ?? "claude-haiku-5-5";
  const fields = { ...(p.displayName ? { displayName: p.displayName } : {}), label: p.label, persona: p.persona, model, webSearch: p.webSearch, computer: p.computer, mcpServers };
  const [row] = await db
    .insert(botDefinitions)
    .values({ id: crypto.randomUUID(), tenantId, name: p.name, ...fields })
    .onConflictDoUpdate({ target: [botDefinitions.tenantId, botDefinitions.name], set: { ...fields, updatedAt: new Date() } })
    .returning();
  return row;
}

export async function assignToChat(db: Db, chatId: string, definitionId: string): Promise<void> {
  await db.insert(chatAssignments).values({ chatId, definitionId }).onConflictDoNothing();
}

export async function setChatLabel(db: Db, tenantId: string, chatId: string, label: string): Promise<void> {
  const value = label.trim() || null;
  if (value && value.length > 80) throw new DirectoryError("Label is too long (80 characters at most)");
  const rows = await db.update(chats).set({ label: value }).where(and(eq(chats.id, chatId), eq(chats.tenantId, tenantId))).returning({ id: chats.id });
  if (!rows.length) throw new DirectoryError("Chat not found");
}

/** One bot per chat: replaces any existing link, or clears it when definitionId is null. */
export async function setChatDefinition(db: Db, tenantId: string, chatId: string, definitionId: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    const [chat] = await tx.select({ id: chats.id }).from(chats).where(and(eq(chats.id, chatId), eq(chats.tenantId, tenantId)));
    if (!chat) throw new DirectoryError("Chat not found");
    if (definitionId && !(await tx.select({ id: botDefinitions.id }).from(botDefinitions).where(and(eq(botDefinitions.id, definitionId), eq(botDefinitions.tenantId, tenantId)))).length) throw new DirectoryError("Bot not found");
    await tx.delete(chatAssignments).where(eq(chatAssignments.chatId, chatId));
    if (definitionId) await tx.insert(chatAssignments).values({ chatId, definitionId });
  });
}

export async function definitionsForChat(db: Db, chatId: string): Promise<BotDefinition[]> {
  const rows = await db
    .select({ def: botDefinitions })
    .from(chatAssignments)
    .innerJoin(botDefinitions, eq(chatAssignments.definitionId, botDefinitions.id))
    .where(eq(chatAssignments.chatId, chatId));
  return rows.map((r) => r.def);
}

// stdio servers get no service secrets, only what a command needs to start
const stdioEnv = () => ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" });

export function mcpServerConfigs(def: BotDefinition, secretsKey: Buffer): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const s of def.mcpServers) {
    // saved before the name was reserved: skipped so it never shadows a built-in
    if (isReservedMcpName(s.name)) {
      console.error(`bot ${def.id}: MCP server "${s.name}" skipped, the name is reserved`);
      continue;
    }
    if (s.transport === "http" && !s.url) throw new Error(`MCP server ${s.name} has no url`);
    if (s.transport === "stdio" && !s.command) throw new Error(`MCP server ${s.name} has no command`);
    out[s.name] =
      s.transport === "http"
        ? {
            type: "http",
            url: s.url!,
            ...(s.headersCipher ? { headers: JSON.parse(decrypt(secretsKey, s.headersCipher)) as Record<string, string> } : {}),
          }
        : { type: "stdio", command: s.command!, ...(s.args ? { args: s.args } : {}), env: stdioEnv() };
  }
  return out;
}

export type McpServerInput = z.input<typeof mcpServerInput>;

export const listDefinitions = (db: Db, tenantId: string): Promise<BotDefinition[]> =>
  db.select().from(botDefinitions).where(eq(botDefinitions.tenantId, tenantId)).orderBy(asc(botDefinitions.name));

export async function getDefinition(db: Db, tenantId: string, id: string): Promise<BotDefinition | undefined> {
  const [row] = await db.select().from(botDefinitions).where(and(eq(botDefinitions.id, id), eq(botDefinitions.tenantId, tenantId)));
  return row;
}

export async function setPersona(db: Db, tenantId: string, id: string, persona: string): Promise<void> {
  await db.update(botDefinitions).set({ persona, updatedAt: new Date() }).where(and(eq(botDefinitions.id, id), eq(botDefinitions.tenantId, tenantId)));
}

/** Never touches mcpServers, so stored headers survive a form save. */
export async function updateDefinitionFields(
  db: Db,
  tenantId: string,
  id: string,
  f: { label: string; persona: string; model: string; webSearch: boolean; computer: boolean; displayName?: string },
): Promise<void> {
  if (!f.label.trim() || !f.model.trim()) throw new DirectoryError("Label and model are required");
  const { displayName, ...rest } = f;
  if (displayName && displayName.trim().length > 60) throw new DirectoryError("Name is too long (60 characters at most)");
  await db.update(botDefinitions).set({ ...rest, ...(displayName === undefined ? {} : { displayName: displayName.trim() || null }), updatedAt: new Date() }).where(and(eq(botDefinitions.id, id), eq(botDefinitions.tenantId, tenantId)));
}

export async function allowedDepartments(db: Db, definitionId: string): Promise<string[]> {
  const rows = await db.select({ id: definitionDepartments.departmentId }).from(definitionDepartments).where(eq(definitionDepartments.definitionId, definitionId));
  return rows.map((r) => r.id);
}

export async function setAllowedDepartments(db: Db, tenantId: string, id: string, departmentIds: string[]): Promise<void> {
  if (!(await getDefinition(db, tenantId, id))) throw new DirectoryError("Bot not found");
  const valid = departmentIds.length
    ? await db.select({ id: departments.id }).from(departments).where(and(eq(departments.tenantId, tenantId), inArray(departments.id, departmentIds)))
    : [];
  await db.transaction(async (tx) => {
    await tx.delete(definitionDepartments).where(eq(definitionDepartments.definitionId, id));
    if (valid.length) await tx.insert(definitionDepartments).values(valid.map((d) => ({ definitionId: id, departmentId: d.id })));
  });
}

const lockedMcpServers = async (tx: Pick<Db, "select">, tenantId: string, id: string) => {
  const [def] = await tx.select().from(botDefinitions).where(and(eq(botDefinitions.id, id), eq(botDefinitions.tenantId, tenantId))).for("update");
  if (!def) throw new DirectoryError("Bot not found");
  return def.mcpServers;
};

export async function addMcpServer(db: Db, secretsKey: Buffer, tenantId: string, id: string, server: McpServerInput): Promise<void> {
  const parsed = mcpServerInput.safeParse(server);
  if (!parsed.success) throw new DirectoryError(parsed.error.issues[0].message);
  const { headers, ...rest } = parsed.data;
  const record: McpServerRecord = { ...rest, ...(headers && Object.keys(headers).length > 0 ? { headersCipher: encrypt(secretsKey, JSON.stringify(headers)) } : {}) };
  await db.transaction(async (tx) => {
    const current = await lockedMcpServers(tx, tenantId, id);
    if (current.some((s) => s.name === rest.name)) throw new DirectoryError(`MCP server "${rest.name}" already exists`);
    await tx.update(botDefinitions).set({ mcpServers: [...current, record], updatedAt: new Date() }).where(eq(botDefinitions.id, id));
  });
}

export async function removeMcpServer(db: Db, tenantId: string, id: string, name: string): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await lockedMcpServers(tx, tenantId, id);
    await tx.update(botDefinitions).set({ mcpServers: current.filter((s) => s.name !== name), updatedAt: new Date() }).where(eq(botDefinitions.id, id));
  });
}
