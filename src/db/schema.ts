import { boolean, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, unique } from "drizzle-orm/pg-core";

export type McpServerRecord = {
  name: string;
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  headersCipher?: string;
  readOnlyTools: string[];
};

export type Authority = { type: "confirmation"; personId: string } | { type: "grant"; personId: string; routineId: string };

/** Per-turn phase times as ISO strings; rows from before timings existed have none. */
export type TurnTimings = { receivedAt: string; engineReadyAt?: string; firstOutputAt?: string; firstToolAt?: string; resultAt?: string; sentAt?: string; tools: number; live?: boolean };

export type ConnectionConfig =
  | { port: number; username: string }
  | { auth?: { in: "header" | "query"; name: string; prefix?: string } }
  | { headerName?: string; readOnlyTools: string[] };

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  retentionDays: integer("retention_days").notNull().default(90),
  botName: text("bot_name"),
  defaultModel: text("default_model"),
  timezone: text("timezone").notNull().default("UTC"),
  createdAt: createdAt(),
});

export const people = pgTable(
  "people",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    aadObjectId: text("aad_object_id").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull().default("user"),
    personalBot: boolean("personal_bot").notNull().default(false),
    email: text("email"),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.tenantId, t.aadObjectId)],
);

export const chats = pgTable("chats", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  conversationType: text("conversation_type").notNull(), // personal | groupChat | channel
  conversationReference: jsonb("conversation_reference"),
  label: text("label"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const botDefinitions = pgTable(
  "bot_definitions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    name: text("name").notNull(),
    label: text("label").notNull(),
    persona: text("persona").notNull(),
    model: text("model").notNull(),
    webSearch: boolean("web_search").notNull(),
    computer: boolean("computer").notNull(),
    mcpServers: jsonb("mcp_servers").$type<McpServerRecord[]>().notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.tenantId, t.name)],
);

export const departments = pgTable(
  "departments",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.tenantId, t.name)],
);

export const departmentMembers = pgTable(
  "department_members",
  {
    departmentId: text("department_id").notNull().references(() => departments.id, { onDelete: "cascade" }),
    personId: text("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
    isHead: boolean("is_head").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.departmentId, t.personId] })],
);

export const definitionDepartments = pgTable(
  "definition_departments",
  {
    definitionId: text("definition_id").notNull().references(() => botDefinitions.id),
    departmentId: text("department_id").notNull().references(() => departments.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.definitionId, t.departmentId] })],
);

export const chatAssignments = pgTable(
  "chat_assignments",
  {
    chatId: text("chat_id").notNull().references(() => chats.id),
    definitionId: text("definition_id").notNull().references(() => botDefinitions.id),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.definitionId] })],
);

export const sessions = pgTable(
  "sessions",
  {
    chatId: text("chat_id").notNull().references(() => chats.id),
    definitionId: text("definition_id").notNull().references(() => botDefinitions.id),
    sdkSessionId: text("sdk_session_id").notNull(),
    /** The last total_cost_usd the engine reported for this session; a turn's cost is the growth since. */
    lastCostUsd: numeric("last_cost_usd", { precision: 12, scale: 6 }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.definitionId] })],
);

export const computers = pgTable("computers", {
  definitionId: text("definition_id").primaryKey().references(() => botDefinitions.id),
  containerId: text("container_id").notNull(),
  createdAt: createdAt(),
});

export const auditEvents = pgTable("audit_events", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  chatId: text("chat_id").notNull().references(() => chats.id),
  definitionId: text("definition_id").notNull().references(() => botDefinitions.id),
  personId: text("person_id").references(() => people.id),
  kind: text("kind").notNull(), // tool | message
  toolName: text("tool_name"),
  toolInput: jsonb("tool_input"),
  summary: text("summary").notNull(),
  status: text("status").notNull(), // pending | done | denied | expired | failed
  authority: jsonb("authority").$type<Authority>(),
  model: text("model"),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
  timings: jsonb("timings").$type<TurnTimings>(), // message rows only
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const connections = pgTable(
  "connections",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    name: text("name").notNull(),
    kind: text("kind").notNull(), // ssh | http | mcp
    target: text("target").notNull(), // ssh host, http base URL, mcp server URL
    config: jsonb("config").$type<ConnectionConfig>().notNull(),
    mode: text("mode").notNull(), // read-only | change
    status: text("status").notNull(), // pending | awaiting-approval | active | blocked | revoked
    secretCipher: text("secret_cipher"),
    publicKey: text("public_key"),
    hostKey: text("host_key"),
    requestedByPersonId: text("requested_by_person_id").references(() => people.id),
    approvedByPersonId: text("approved_by_person_id").references(() => people.id),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.tenantId, t.name)],
);

export const secretLinks = pgTable("secret_links", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  connectionId: text("connection_id").notNull().references(() => connections.id, { onDelete: "cascade" }),
  personId: text("person_id").notNull().references(() => people.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const definitionConnections = pgTable(
  "definition_connections",
  {
    definitionId: text("definition_id").notNull().references(() => botDefinitions.id),
    connectionId: text("connection_id").notNull().references(() => connections.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.definitionId, t.connectionId] })],
);

export const knowledgeVersions = pgTable(
  "knowledge_versions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    path: text("path").notNull(),
    version: integer("version").notNull(),
    bodyCipher: text("body_cipher").notNull(),
    deleted: boolean("deleted").notNull().default(false),
    authorPersonId: text("author_person_id").references(() => people.id),
    authorDefinitionId: text("author_definition_id").references(() => botDefinitions.id),
    chatId: text("chat_id"),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.tenantId, t.path, t.version)],
);

export const routines = pgTable("routines", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  definitionId: text("definition_id").notNull().references(() => botDefinitions.id),
  chatId: text("chat_id").notNull().references(() => chats.id),
  prompt: text("prompt").notNull(),
  schedule: text("schedule"), // 5-field cron
  runAt: timestamp("run_at", { withTimezone: true }),
  quiet: boolean("quiet").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  grantPersonId: text("grant_person_id").references(() => people.id),
  createdByPersonId: text("created_by_person_id").notNull().references(() => people.id),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export type Tenant = typeof tenants.$inferSelect;
export type Person = typeof people.$inferSelect;
export type Department = typeof departments.$inferSelect;
export type Chat = typeof chats.$inferSelect;
export type BotDefinition = typeof botDefinitions.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Computer = typeof computers.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type KnowledgeVersion = typeof knowledgeVersions.$inferSelect;
export type Routine = typeof routines.$inferSelect;
