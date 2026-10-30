import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import type { AuditEvent } from "../db/schema.js";

export async function beginAction(
  db: Db,
  input: {
    tenantId: string;
    chatId: string;
    definitionId: string;
    personId?: string;
    kind: "tool" | "message";
    toolName?: string;
    toolInput?: unknown;
    summary: string;
    model?: string;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(auditEvents).values({ ...input, id, status: "pending" });
  return id;
}

export async function completeAction(
  db: Db,
  id: string,
  input: { status: "done" | "denied" | "expired" | "failed"; authority?: { type: "confirmation"; personId: string }; costUsd?: number },
): Promise<void> {
  await db
    .update(auditEvents)
    .set({
      status: input.status,
      finishedAt: new Date(),
      ...(input.authority ? { authority: input.authority } : {}),
      ...(input.costUsd !== undefined ? { costUsd: input.costUsd.toString() } : {}),
    })
    .where(eq(auditEvents.id, id));
}

export async function recordAuthority(db: Db, id: string, authority: { type: "confirmation"; personId: string }): Promise<void> {
  await db.update(auditEvents).set({ authority }).where(eq(auditEvents.id, id));
}

export async function listActions(
  db: Db,
  filter: { tenantId: string; chatId?: string; definitionId?: string; personId?: string; limit?: number },
): Promise<AuditEvent[]> {
  const conditions = [eq(auditEvents.tenantId, filter.tenantId)];
  if (filter.chatId) conditions.push(eq(auditEvents.chatId, filter.chatId));
  if (filter.definitionId) conditions.push(eq(auditEvents.definitionId, filter.definitionId));
  if (filter.personId) conditions.push(eq(auditEvents.personId, filter.personId));
  return db
    .select()
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(desc(auditEvents.startedAt))
    .limit(filter.limit ?? 100);
}

// shortcut: summaries are plain text cut at 200 characters, no redaction; revisit if tool inputs carry secrets.
export function summarise(toolName: string, toolInput: unknown): string {
  const input = toolInput as Record<string, unknown> | null;
  if (toolName === "mcp__computer__bash") {
    return typeof input?.command === "string" ? input.command.slice(0, 200) : toolName;
  }
  if (toolName.startsWith("mcp__")) {
    const tool = toolName.slice(toolName.lastIndexOf("__") + 2);
    return `${tool} ${JSON.stringify(toolInput)}`.slice(0, 200);
  }
  return toolName;
}
