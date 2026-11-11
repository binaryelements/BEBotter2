import type { McpServerConfig } from "../engine/mcp.js";
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { GRAPH_CAPABILITIES, botDefinitions, chatAssignments, chats, definitionDepartments, departments, people, tenants } from "../db/schema.js";
import type { BotDefinition, McpServerRecord } from "../db/schema.js";
import { mayUseDefinition } from "../admin/access.js";
import { DirectoryError } from "../org/directory.js";
import { getTenantSettings, upsertTenant } from "../org/org.js";
import { resolveModel } from "../engine/providers.js";
import { decrypt, encrypt } from "../secrets/cipher.js";

export const RESERVED_MCP_NAMES = ["computer", "knowledge", "connections", "routine", "mail", "m365", "browser", "learnings", "bots"] as const;

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
  const model = p.model ?? (await getTenantSettings(db, tenantId)).defaultModel ?? "deepseek/deepseek-flash";
  const fields = { ...(p.displayName ? { displayName: p.displayName } : {}), label: p.label, persona: p.persona, model, webSearch: p.webSearch, computer: p.computer, mcpServers };
  const [row] = await db
    .insert(botDefinitions)
    .values({ id: crypto.randomUUID(), tenantId, name: p.name, ...fields })
    .onConflictDoUpdate({ target: [botDefinitions.tenantId, botDefinitions.name], set: { ...fields, updatedAt: new Date() } })
    .returning();
  return row;
}

export const PERSONAL_PERSONA =
  "You are the personal assistant of the person you are talking to. You act as them in Microsoft 365: their mail, calendar, files and Teams chats. Be brief. Before you send, reply, book, accept or save anything, say exactly what you will do; the person confirms it in the chat.";

/** One built-in Personal definition per tenant; safe to call again and concurrently. */
export async function ensurePersonalDefinition(db: Db, tenantId: string, defaultModel: string): Promise<BotDefinition> {
  const model = (await getTenantSettings(db, tenantId)).defaultModel ?? defaultModel;
  await db
    .insert(botDefinitions)
    .values({ id: crypto.randomUUID(), tenantId, name: "personal", label: "My assistant", persona: PERSONAL_PERSONA, model, webSearch: false, computer: false, identity: "person", graph: [...GRAPH_CAPABILITIES], mcpServers: [] })
    .onConflictDoNothing({ target: [botDefinitions.tenantId, botDefinitions.name] });
  const [row] = await db.select().from(botDefinitions).where(and(eq(botDefinitions.tenantId, tenantId), eq(botDefinitions.name, "personal")));
  if (row.identity !== "person") throw new DirectoryError('A bot named "personal" already exists; rename it so the built-in Personal assistant can be created');
  return row;
}

/**
 * The one Personal assistant a person is allowed to have. The person must be switched on first
 * (people.personalBot), so an admin controls who gets one. The old tenant-wide "personal" definition
 * is adopted by the first person who needs one, so its memory and learnings survive the change.
 */
export async function ensurePersonalAssistant(db: Db, tenantId: string, personId: string, defaultModel: string): Promise<BotDefinition> {
  const [person] = await db.select({ on: people.personalBot }).from(people).where(and(eq(people.id, personId), eq(people.tenantId, tenantId)));
  if (!person) throw new DirectoryError("Person not found");
  if (!person.on) throw new DirectoryError("This person is not allowed a personal assistant");
  const [mine] = await db.select().from(botDefinitions).where(and(eq(botDefinitions.tenantId, tenantId), eq(botDefinitions.ownerPersonId, personId)));
  if (mine) return mine;
  // adopt the old tenant-wide definition if it has no owner yet
  const [legacy] = await db.select().from(botDefinitions).where(and(eq(botDefinitions.tenantId, tenantId), eq(botDefinitions.identity, "person"), isNull(botDefinitions.ownerPersonId))).limit(1);
  if (legacy) {
    const [row] = await db.update(botDefinitions).set({ ownerPersonId: personId, updatedAt: new Date() }).where(eq(botDefinitions.id, legacy.id)).returning();
    return row;
  }
  const model = (await getTenantSettings(db, tenantId)).defaultModel ?? defaultModel;
  const [row] = await db
    .insert(botDefinitions)
    .values({
      id: crypto.randomUUID(),
      tenantId,
      name: `pa-${personId}`,
      label: "My assistant",
      persona: PERSONAL_PERSONA,
      model,
      webSearch: false,
      computer: false,
      identity: "person",
      ownerPersonId: personId,
      graph: [...GRAPH_CAPABILITIES],
      mcpServers: [],
    })
    .returning();
  return row;
}

/**
 * Point a personal assistant at the person it acts for; null leaves it unowned, which the assistants page shows and
 * the first allowed person then adopts. One assistant per person, so a person who already has one is refused.
 */
export async function setAssistantOwner(db: Db, tenantId: string, definitionId: string, personId: string | null): Promise<void> {
  if (personId) {
    const [taken] = await db
      .select({ id: botDefinitions.id })
      .from(botDefinitions)
      .where(and(eq(botDefinitions.tenantId, tenantId), eq(botDefinitions.ownerPersonId, personId), ne(botDefinitions.id, definitionId)));
    if (taken) throw new DirectoryError("That person already has a personal assistant");
  }
  const rows = await db
    .update(botDefinitions)
    .set({ ownerPersonId: personId, updatedAt: new Date() })
    .where(and(eq(botDefinitions.id, definitionId), eq(botDefinitions.tenantId, tenantId), eq(botDefinitions.identity, "person")))
    .returning({ id: botDefinitions.id });
  if (!rows.length) throw new DirectoryError("Personal assistant not found");
}

/** One-time: point bots whose model the engine cannot resolve at the tenant's supported default. */
export async function backfillBotModels(db: Db, tenantId: string, envDefault: string): Promise<void> {
  const settings = await getTenantSettings(db, tenantId);
  const supported = (slug: string | null | undefined) => !!slug && !!resolveModel(slug);
  const fallback = supported(settings.defaultModel) ? settings.defaultModel! : supported(envDefault) ? envDefault : "deepseek/deepseek-flash";
  const defs = await listDefinitions(db, tenantId);
  const stale = defs.filter((d) => !supported(d.model));
  if (!stale.length) return;
  await db.update(botDefinitions).set({ model: fallback, updatedAt: new Date() }).where(and(eq(botDefinitions.tenantId, tenantId), inArray(botDefinitions.id, stale.map((d) => d.id))));
  if (!supported(settings.defaultModel)) await db.update(tenants).set({ defaultModel: fallback }).where(eq(tenants.id, tenantId));
  console.log(`bot models for tenant ${tenantId}: ${stale.length} moved to ${fallback}`);
}

/** One-time: give the old tenant-wide Personal definition to the person who has it switched on. */
export async function backfillPersonalAssistants(db: Db, tenantId: string, defaultModel: string): Promise<void> {
  const [legacy] = await db.select().from(botDefinitions).where(and(eq(botDefinitions.tenantId, tenantId), eq(botDefinitions.identity, "person"), isNull(botDefinitions.ownerPersonId))).limit(1);
  if (!legacy) return;
  const on = await db.select({ id: people.id }).from(people).where(and(eq(people.tenantId, tenantId), eq(people.personalBot, true)));
  if (!on.length) return;
  await db.update(botDefinitions).set({ ownerPersonId: on[0].id, updatedAt: new Date() }).where(eq(botDefinitions.id, legacy.id));
  for (const p of on.slice(1)) await ensurePersonalAssistant(db, tenantId, p.id, defaultModel).catch((e) => {
    if (!(e instanceof DirectoryError)) throw e;
  });
}

/** A Personal assistant works only in its owner's one-to-one chat; the owner is checked once it is recorded. */
async function checkPersonDefinition(db: Db, chatId: string, definitionId: string): Promise<void> {
  const [def] = await db.select({ identity: botDefinitions.identity, owner: botDefinitions.ownerPersonId }).from(botDefinitions).where(eq(botDefinitions.id, definitionId));
  if (def?.identity !== "person") return;
  // a personal chat with no recorded owner passes until the owner is recorded on the first message
  const [chat] = await db.select({ type: chats.conversationType, owner: chats.ownerPersonId }).from(chats).where(eq(chats.id, chatId));
  if (chat?.type !== "personal") throw new DirectoryError("A personal assistant works only in a one-to-one chat");
  if (chat.owner && def.owner && chat.owner !== def.owner) throw new DirectoryError("This assistant belongs to someone else");
  if (chat.owner) {
    const [p] = await db.select({ on: people.personalBot }).from(people).where(eq(people.id, chat.owner));
    if (!p?.on) throw new DirectoryError("The chat owner has no personal assistant");
  }
}

export async function assignToChat(db: Db, chatId: string, definitionId: string): Promise<void> {
  await checkPersonDefinition(db, chatId, definitionId);
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
  if (definitionId) await checkPersonDefinition(db, chatId, definitionId);
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

/** The bots a person may talk to: their own Personal assistant first (when switched on), then the others by label. */
export async function usableDefinitions(db: Db, tenantId: string, personId: string, defaultModel: string): Promise<BotDefinition[]> {
  const [p] = await db.select({ on: people.personalBot }).from(people).where(and(eq(people.id, personId), eq(people.tenantId, tenantId)));
  if (p?.on) await ensurePersonalAssistant(db, tenantId, personId, defaultModel).catch((e) => {
      if (!(e instanceof DirectoryError)) throw e;
      console.error(`personal assistant for ${personId}:`, e.message);
    });
  const all = await db.select().from(botDefinitions).where(eq(botDefinitions.tenantId, tenantId));
  const usable: BotDefinition[] = [];
  for (const d of all) if (await mayUseDefinition(db, tenantId, personId, d.id)) usable.push(d);
  const rank = (d: BotDefinition) => (d.identity === "person" ? 0 : 1);
  return usable.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
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
  // a person bot needs a computer per person, which does not exist yet
  const [def] = await db.select({ identity: botDefinitions.identity }).from(botDefinitions).where(and(eq(botDefinitions.id, id), eq(botDefinitions.tenantId, tenantId)));
  if (def?.identity === "person") rest.computer = false;
  await db.update(botDefinitions).set({ ...rest, ...(displayName === undefined ? {} : { displayName: displayName.trim() || null }), updatedAt: new Date() }).where(and(eq(botDefinitions.id, id), eq(botDefinitions.tenantId, tenantId)));
}

/** Per-bot daily reflection; the group is checked against the bot's chats by the admin route. */
export async function setReflectionSettings(
  db: Db,
  tenantId: string,
  id: string,
  f: { mode: "off" | "propose" | "auto"; chatId: string | null; hour: number },
): Promise<void> {
  const [row] = await db
    .update(botDefinitions)
    .set({ reflectionMode: f.mode, reflectionChatId: f.chatId, reflectionHour: f.hour, updatedAt: new Date() })
    .where(and(eq(botDefinitions.id, id), eq(botDefinitions.tenantId, tenantId)))
    .returning({ id: botDefinitions.id });
  if (!row) throw new DirectoryError("Bot not found");
}

/** Saves a Personal assistant's Microsoft 365 capabilities; unknown names are dropped and identity is never touched. */
export async function setGraph(db: Db, tenantId: string, id: string, graph: string[]): Promise<void> {
  const rows = await db
    .update(botDefinitions)
    .set({ graph: GRAPH_CAPABILITIES.filter((c) => graph.includes(c)), updatedAt: new Date() })
    .where(and(eq(botDefinitions.id, id), eq(botDefinitions.tenantId, tenantId), eq(botDefinitions.identity, "person")))
    .returning({ id: botDefinitions.id });
  if (!rows.length) throw new DirectoryError("Bot not found");
}

/** Switching a person's assistant off: their own one-to-one chat goes back to the choose card; nothing else moves. */
export async function clearPersonalChat(db: Db, tenantId: string, personId: string): Promise<void> {
  const rows = await db
    .select({ id: chats.id })
    .from(chats)
    .innerJoin(chatAssignments, eq(chatAssignments.chatId, chats.id))
    .innerJoin(botDefinitions, eq(botDefinitions.id, chatAssignments.definitionId))
    .where(and(eq(chats.tenantId, tenantId), eq(chats.ownerPersonId, personId), eq(botDefinitions.identity, "person")));
  for (const r of rows) await setChatDefinition(db, tenantId, r.id, null);
}

export async function allowedDepartments(db: Db, definitionId: string): Promise<string[]> {
  const rows = await db.select({ id: definitionDepartments.departmentId }).from(definitionDepartments).where(eq(definitionDepartments.definitionId, definitionId));
  return rows.map((r) => r.id);
}

export async function setAllowedDepartments(db: Db, tenantId: string, id: string, departmentIds: string[]): Promise<void> {
  const def = await getDefinition(db, tenantId, id);
  if (!def) throw new DirectoryError("Bot not found");
  // Personal is switched on per person (People page), never by department
  if (def.identity === "person" && departmentIds.length) throw new DirectoryError("Personal is switched on per person, not by department");
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
