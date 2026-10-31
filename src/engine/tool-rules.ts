import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { definitionTools, toolRules } from "../db/schema.js";
import type { ToolRule } from "./gate.js";

/** Records the tools the engine announced for a bot (its init message), first and last seen. */
export async function recordTools(db: Db, definitionId: string, tools: string[]): Promise<void> {
  if (!tools.length) return;
  await db
    .insert(definitionTools)
    .values([...new Set(tools)].map((toolName) => ({ definitionId, toolName })))
    .onConflictDoUpdate({ target: [definitionTools.definitionId, definitionTools.toolName], set: { lastSeen: sql`now()` } });
}

export async function knownTools(db: Db, definitionId: string): Promise<string[]> {
  const rows = await db.select({ toolName: definitionTools.toolName }).from(definitionTools).where(eq(definitionTools.definitionId, definitionId)).orderBy(definitionTools.toolName);
  return rows.map((r) => r.toolName);
}

export async function toolRule(db: Db, definitionId: string, toolName: string): Promise<ToolRule | undefined> {
  const [row] = await db.select({ rule: toolRules.rule }).from(toolRules).where(and(eq(toolRules.definitionId, definitionId), eq(toolRules.toolName, toolName)));
  return row?.rule;
}

export async function toolRulesFor(db: Db, definitionId: string): Promise<Map<string, ToolRule>> {
  const rows = await db.select().from(toolRules).where(eq(toolRules.definitionId, definitionId));
  return new Map(rows.map((r) => [r.toolName, r.rule]));
}

/** undefined clears the rule, so the tool follows its default again. */
export async function setToolRule(db: Db, definitionId: string, toolName: string, rule: ToolRule | undefined): Promise<void> {
  if (!rule) {
    await db.delete(toolRules).where(and(eq(toolRules.definitionId, definitionId), eq(toolRules.toolName, toolName)));
    return;
  }
  await db.insert(toolRules).values({ definitionId, toolName, rule }).onConflictDoUpdate({ target: [toolRules.definitionId, toolRules.toolName], set: { rule } });
}

/** Where a tool comes from: its MCP server, or "web" for the engine's own tools. */
export const toolSource = (toolName: string) => /^mcp__(.+?)__/.exec(toolName)?.[1] ?? "web";
