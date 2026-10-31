import { boolean, jsonb, numeric, pgTable, primaryKey, text, timestamp, unique } from "drizzle-orm/pg-core";

export type McpServerRecord = {
  name: string;
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  headersCipher?: string;
  readOnlyTools: string[];
};

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const people = pgTable(
  "people",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id),
    aadObjectId: text("aad_object_id").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.tenantId, t.aadObjectId)],
);

export const chats = pgTable("chats", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id),
  conversationType: text("conversation_type").notNull(), // personal | groupChat | channel
  conversationReference: jsonb("conversation_reference"),
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
  authority: jsonb("authority").$type<{ type: "confirmation"; personId: string }>(),
  model: text("model"),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export type Tenant = typeof tenants.$inferSelect;
export type Person = typeof people.$inferSelect;
export type Chat = typeof chats.$inferSelect;
export type BotDefinition = typeof botDefinitions.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Computer = typeof computers.$inferSelect;
