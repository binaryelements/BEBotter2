import { boolean, customType, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { EngineMessage } from "../engine/engine.js";

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
  /** Which bot's name frames an alert, who receives it, and what is worth an email. */
  alertBotId: text("alert_bot_id"),
  alertEmails: text("alert_emails"),
  alertLowBalance: boolean("alert_low_balance").notNull().default(true),
  alertFailures: boolean("alert_failures").notNull().default(true),
  alertApprovals: boolean("alert_approvals").notNull().default(false),
  alertBalanceThreshold: integer("alert_balance_threshold").notNull().default(5),
  reportEnabled: boolean("report_enabled").notNull().default(true),
  /** Local hour (0-23) in the tenant zone when the daily report is sent. */
  reportHour: integer("report_hour").notNull().default(8),
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
    licensed: boolean("licensed").notNull().default(true), // has a Microsoft 365 licence; unlicensed rows stay for history but are hidden from People
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
    /** A person bot belongs to one person; service bots have no owner. */
    ownerPersonId: text("owner_person_id").references(() => people.id),
    graph: jsonb("graph").$type<GraphCapability[]>().notNull().default([]),
    mcpServers: jsonb("mcp_servers").$type<McpServerRecord[]>().notNull(),
    /** Daily self-reflection for this bot: off, propose learnings for approval, or apply them and post to its group. */
    reflectionMode: text("reflection_mode").notNull().default("off"), // off | propose | auto
    /** The group chat this bot's auto reflection posts to; it must be one of the bot's chats. */
    reflectionChatId: text("reflection_chat_id"),
    /** Local hour (0-23) in the tenant zone when this bot's reflection runs. */
    reflectionHour: integer("reflection_hour").notNull().default(18),
    /** The bot's one inbound URL: an encrypted secret an outside system posts with, the chat its replies go to, and the admin who created it. */
    inboundSecret: text("inbound_secret"),
    inboundChatId: text("inbound_chat_id"),
    inboundBy: text("inbound_by").references(() => people.id),
    inboundAt: timestamp("inbound_at", { withTimezone: true }),
    inboundHits: integer("inbound_hits").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.tenantId, t.name), unique().on(t.tenantId, t.ownerPersonId)],
);

/** A request from one person's assistant to another's; the body is the only thing shared. */
export const assistantRequests = pgTable(
  "assistant_requests",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    fromDefinitionId: text("from_definition_id").notNull().references(() => botDefinitions.id),
    toDefinitionId: text("to_definition_id").notNull().references(() => botDefinitions.id),
    fromPersonId: text("from_person_id").notNull().references(() => people.id),
    toPersonId: text("to_person_id").notNull().references(() => people.id),
    kind: text("kind").notNull().default("request"), // request | todo
    body: text("body").notNull(),
    status: text("status").notNull().default("pending"), // pending | accepted | declined | done
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("assistant_requests_to_idx").on(t.toDefinitionId, t.status)],
);
export type AssistantRequest = typeof assistantRequests.$inferSelect;

/** A personal to-do. The PA can add, list and complete these for its owner. */
export const todos = pgTable(
  "todos",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    personId: text("person_id").notNull().references(() => people.id),
    definitionId: text("definition_id").references(() => botDefinitions.id),
    requestId: text("request_id").references(() => assistantRequests.id),
    title: text("title").notNull(),
    details: text("details"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    status: text("status").notNull().default("open"), // open | done
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("todos_person_idx").on(t.personId, t.status, t.dueAt)],
);
export type Todo = typeof todos.$inferSelect;

/** One row per alert actually sent, so the same condition does not email every tick. */
export const alertLog = pgTable(
  "alert_log",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    kind: text("kind").notNull(), // balance | failures | approvals | test
    fingerprint: text("fingerprint").notNull(),
    sentAt: createdAt(),
  },
  (t) => [index("alert_log_tenant_idx").on(t.tenantId, t.kind, t.sentAt)],
);
export type AlertLog = typeof alertLog.$inferSelect;

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
    /** Legacy: Claude's resume token. Nothing writes it now; kept for old rows. */
    sdkSessionId: text("sdk_session_id"),
    /** The last turn's cost, for the admin screen. */
    lastCostUsd: numeric("last_cost_usd", { precision: 12, scale: 6 }),
    /** The neutral transcript an engine that replays history uses. */
    messages: jsonb("messages").$type<EngineMessage[]>(),
    /** The oldest turns folded into a note, so a long chat stays under the context limit. */
    summary: text("summary"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    provider: text("provider"),
    model: text("model"),
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
    description: text("description"), // what the system is for and how a bot should treat it, shown to the bot
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

/** Per-bot access to one linked connection: read-only, ask on change, free for change, or no access. */
export const connectionGrants = pgTable(
  "connection_grants",
  {
    definitionId: text("definition_id").notNull().references(() => botDefinitions.id, { onDelete: "cascade" }),
    connectionId: text("connection_id").notNull().references(() => connections.id, { onDelete: "cascade" }),
    mode: text("mode").notNull(), // read | confirm | free | deny
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.definitionId, t.connectionId] })],
);
export type ConnectionGrant = typeof connectionGrants.$inferSelect;

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
    /** Whose note this is: a bot's runbook, or null for one the whole company shares. */
    definitionId: text("definition_id").references(() => botDefinitions.id, { onDelete: "set null" }),
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
  /** taught: a person said it in a chat or an admin added it; reflection: the daily self-review proposed or applied it. */
  source: text("source").notNull().default("taught"), // taught | reflection
  /** set on a Personal assistant's learnings: they apply to that person's chats only, since Personal is one bot shared by everyone */
  ownerPersonId: text("owner_person_id").references(() => people.id),
  taughtByPersonId: text("taught_by_person_id").notNull().references(() => people.id),
  chatId: text("chat_id").references(() => chats.id), // null when an admin added it on the admin site
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Learning = typeof learnings.$inferSelect;

/** One bot's daily self-review: what happened, what went wrong, what was corrected, and what it will do differently. */
export const reflections = pgTable("reflections", {
  id: text("id").primaryKey(),
  /** tenant:definition:owner:day, so a day is reflected on once even if the scheduler ticks twice. */
  key: text("key").notNull().unique(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  definitionId: text("definition_id").notNull().references(() => botDefinitions.id),
  ownerPersonId: text("owner_person_id").references(() => people.id),
  day: text("day").notNull(), // YYYY-MM-DD in the tenant zone
  summary: text("summary").notNull(),
  wentWell: text("went_well"),
  wentWrong: text("went_wrong"),
  corrections: text("corrections"),
  willDo: text("will_do"),
  model: text("model"),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
  createdAt: createdAt(),
});

/** A learning the daily reflection wants to add, change or remove; mode 2 waits for an admin, mode 3 applies it. */
export const learningProposals = pgTable("learning_proposals", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  definitionId: text("definition_id").notNull().references(() => botDefinitions.id),
  ownerPersonId: text("owner_person_id").references(() => people.id),
  reflectionId: text("reflection_id"),
  action: text("action").notNull(), // add | update | remove
  learningId: text("learning_id").references(() => learnings.id, { onDelete: "set null" }),
  text: text("text"),
  reason: text("reason"),
  status: text("status").notNull().default("pending"), // pending | approved | rejected
  decidedByPersonId: text("decided_by_person_id").references(() => people.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export type Reflection = typeof reflections.$inferSelect;
export type LearningProposal = typeof learningProposals.$inferSelect;

/**
 * The long tail of what a bot has learnt. Unlike `learnings` (the small always-on core), these are never all
 * injected: the turn retrieves the few relevant to the message, and the bot can search them with `recall`.
 */
export const memoryItems = pgTable(
  "memory_items",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    definitionId: text("definition_id").notNull().references(() => botDefinitions.id),
    /** set when the memory belongs to one person (a Personal assistant's owner). */
    ownerPersonId: text("owner_person_id").references(() => people.id),
    /** set when the memory is only for one department; null means everyone. */
    departmentId: text("department_id").references(() => departments.id),
    /** set when the memory is only for one chat; null means every chat. */
    chatId: text("chat_id").references(() => chats.id),
    text: text("text").notNull(),
    kind: text("kind").notNull().default("fact"), // fact | rule | procedure | preference
    importance: integer("importance").notNull().default(3), // 1-5
    confidence: numeric("confidence", { precision: 4, scale: 2 }).notNull().default("0.70"),
    source: text("source").notNull().default("taught"), // taught | reflection | runbook
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    useCount: integer("use_count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("memory_items_bot_idx").on(t.tenantId, t.definitionId, t.importance, t.lastUsedAt),
    index("memory_items_owner_idx").on(t.ownerPersonId),
    index("memory_items_department_idx").on(t.departmentId),
    index("memory_items_chat_idx").on(t.chatId),
    index("memory_items_search_idx").using("gin", sql`to_tsvector('english', ${t.text})`),
  ],
);

export type MemoryItem = typeof memoryItems.$inferSelect;
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
