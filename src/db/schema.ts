import { boolean, customType, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, unique } from "drizzle-orm/pg-core";

export type McpServerRecord = {
  name: string;
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  headersCipher?: string;
  readOnlyTools: string[];
};

export const GRAPH_CAPABILITIES = ["mail.read", "mail.send", "calendar.read", "calendar.write", "chats.read", "files.read", "files.write"] as const;
export type GraphCapability = (typeof GRAPH_CAPABILITIES)[number];

export type Authority = { type: "confirmation"; personId: string } | { type: "grant"; personId: string; routineId: string };

/** Per-turn phase times as ISO strings; rows from before timings existed have none. */
export type TurnTimings = { receivedAt: string; engineReadyAt?: string; firstOutputAt?: string; firstToolAt?: string; resultAt?: string; sentAt?: string; tools: number; live?: boolean };

export type ConnectionConfig =
  | { port: number; username: string }
  | { auth?: { in: "header" | "query"; name: string; prefix?: string } }
  | { headerName?: string; readOnlyTools: string[]; /** the server signs BE Teammate in as an OAuth client; the secret then holds its tokens */ oauth?: { clientId: string; authorizationEndpoint: string; tokenEndpoint: string; scope?: string } }
  | { engine: "postgres" | "mysql" | "mssql"; port: number; database: string; username: string; tls?: boolean };

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  retentionDays: integer("retention_days").notNull().default(90),
  botName: text("bot_name"),
  defaultModel: text("default_model"),
  timezone: text("timezone").notNull().default("UTC"),
  location: text("location"),
  country: text("country"),
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
    timezone: text("timezone"), // from their Teams client, e.g. Australia/Melbourne
    location: text("location"), // from the directory: "Melbourne, Australia"
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
  ownerPersonId: text("owner_person_id").references(() => people.id), // whose 1:1 chat it is
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  // group chats: the bot keeps what is said when it is not addressed, as context for when it is; an admin turns it off
  listening: boolean("listening").notNull().default(true),
  createdAt: createdAt(),
});

/** What a group chat said while the bot was not addressed; handed to the bot on its next turn there, then pruned with the audit. */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    chatId: text("chat_id").notNull().references(() => chats.id),
    personId: text("person_id").references(() => people.id),
    name: text("name").notNull(),
    text: text("text").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }), // when a turn read it
  },
  (t) => [index("chat_messages_chat_idx").on(t.chatId, t.at)],
);
export type ChatMessage = typeof chatMessages.$inferSelect;

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
/** A file or image someone posted in a chat, kept so the bot can open it in this turn or a later one; pruned with the audit. */
export const chatAttachments = pgTable(
  "chat_attachments",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    chatId: text("chat_id").notNull().references(() => chats.id),
    personId: text("person_id").references(() => people.id),
    name: text("name").notNull(),
    senderName: text("sender_name").notNull(),
    mediaType: text("media_type").notNull(),
    bytes: bytea("bytes").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [index("chat_attachments_chat_idx").on(t.chatId, t.at)],
);
export type ChatAttachment = typeof chatAttachments.$inferSelect;

export const botDefinitions = pgTable(
  "bot_definitions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    name: text("name").notNull(),
    displayName: text("display_name"), // the bot's name, shown to people and used for its mail address
    label: text("label").notNull(),
    persona: text("persona").notNull(),
    model: text("model").notNull(),
    webSearch: boolean("web_search").notNull(),
    computer: boolean("computer").notNull(),
    identity: text("identity").$type<"service" | "person">().notNull().default("service"), // person: acts as whoever is talking, through Graph
    graph: jsonb("graph").$type<GraphCapability[]>().notNull().default([]),
    mcpServers: jsonb("mcp_servers").$type<McpServerRecord[]>().notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.tenantId, t.name)],
);

export const mailboxes = pgTable("mailboxes", {
  definitionId: text("definition_id").primaryKey().references(() => botDefinitions.id),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  agent: text("agent").notNull(),
  // ids and ciphers stay null until each step succeeds, so a half-finished create can resume
  localPart: text("local_part").unique(), // the address name the admin asked for, kept so a retry uses the same one
  inboxId: text("inbox_id"),
  address: text("address"),
  keyId: text("key_id"),
  keyCipher: text("key_cipher"),
  webhookId: text("webhook_id"),
  webhookSecretCipher: text("webhook_secret_cipher"),
  status: text("status").notNull(), // pending | active | removing | removed
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// delivery ids already handled, so a retry or replay of a webhook posts nothing twice; pruned after a day
export const mailDeliveries = pgTable("mail_deliveries", {
  id: text("id").primaryKey(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

// an admin's choice per bot and tool; a tool with no row runs by its default class
export const toolRules = pgTable(
  "tool_rules",
  {
    definitionId: text("definition_id").notNull().references(() => botDefinitions.id),
    toolName: text("tool_name").notNull(),
    rule: text("rule").$type<"free" | "confirm">().notNull(),
  },
  (t) => [primaryKey({ columns: [t.definitionId, t.toolName] })],
);

// the tools the engine announced for a bot, so the admin page lists them without a hard-coded list
export const definitionTools = pgTable(
  "definition_tools",
  {
    definitionId: text("definition_id").notNull().references(() => botDefinitions.id),
    toolName: text("tool_name").notNull(),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.definitionId, t.toolName] })],
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
  chatId: text("chat_id").references(() => chats.id), // null for admin actions
  definitionId: text("definition_id").notNull().references(() => botDefinitions.id),
  personId: text("person_id").references(() => people.id),
  kind: text("kind").notNull(), // tool | message | admin
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
    kind: text("kind").notNull(), // ssh | http | mcp | sql
    target: text("target").notNull(), // ssh host, http base URL, mcp server URL, database host
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
  /** A job the bot started from a chat: it runs at once in its own session, beside the chat rather than in its queue. */
  background: boolean("background").notNull().default(false),
  grantPersonId: text("grant_person_id").references(() => people.id),
  createdByPersonId: text("created_by_person_id").notNull().references(() => people.id),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/** Something a person taught a bot; it is in the bot's instructions from the next message on. */
export const learnings = pgTable("learnings", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  definitionId: text("definition_id").notNull().references(() => botDefinitions.id),
  text: text("text").notNull(),
  /** set on a Personal assistant's learnings: they apply to that person's chats only, since Personal is one bot shared by everyone */
  ownerPersonId: text("owner_person_id").references(() => people.id),
  taughtByPersonId: text("taught_by_person_id").notNull().references(() => people.id),
  chatId: text("chat_id").references(() => chats.id), // null when an admin added it on the admin site
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Learning = typeof learnings.$inferSelect;
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
