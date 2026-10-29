import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { botDefinitions, chatAssignments } from "../db/schema.js";
import type { BotDefinition, McpServerRecord } from "../db/schema.js";
import { decrypt, encrypt } from "../secrets/cipher.js";

export const botDefinitionInput = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  persona: z.string(),
  model: z.string().default("claude-haiku-5-5"),
  webSearch: z.boolean().default(false),
  computer: z.boolean().default(false),
  mcpServers: z
    .array(
      z.object({
        name: z.string().min(1),
        transport: z.enum(["http", "stdio"]),
        url: z.string().optional(),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        readOnlyTools: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

export type BotDefinitionInput = z.input<typeof botDefinitionInput>;

export async function upsertDefinition(db: Db, secretsKey: Buffer, tenantId: string, input: BotDefinitionInput): Promise<BotDefinition> {
  const p = botDefinitionInput.parse(input);
  const mcpServers: McpServerRecord[] = p.mcpServers.map(({ headers, ...s }) => ({
    ...s,
    ...(headers && Object.keys(headers).length > 0 ? { headersCipher: encrypt(secretsKey, JSON.stringify(headers)) } : {}),
  }));
  const fields = { label: p.label, persona: p.persona, model: p.model, webSearch: p.webSearch, computer: p.computer, mcpServers };
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

export async function definitionsForChat(db: Db, chatId: string): Promise<BotDefinition[]> {
  const rows = await db
    .select({ def: botDefinitions })
    .from(chatAssignments)
    .innerJoin(botDefinitions, eq(chatAssignments.definitionId, botDefinitions.id))
    .where(eq(chatAssignments.chatId, chatId));
  return rows.map((r) => r.def);
}

export function mcpServerConfigs(def: BotDefinition, secretsKey: Buffer): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const s of def.mcpServers) {
    out[s.name] =
      s.transport === "http"
        ? {
            type: "http",
            url: s.url ?? "",
            ...(s.headersCipher ? { headers: JSON.parse(decrypt(secretsKey, s.headersCipher)) as Record<string, string> } : {}),
          }
        : { type: "stdio", command: s.command ?? "", ...(s.args ? { args: s.args } : {}) };
  }
  return out;
}
