import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { pruneOverheard } from "../teams/overheard.js";
import { auditEvents, tenants } from "../db/schema.js";
import type { Authority, AuditEvent, TurnTimings } from "../db/schema.js";

export async function beginAction(
  db: Db,
  input: {
    tenantId: string;
    chatId?: string;
    definitionId: string;
    personId?: string;
    kind: "tool" | "message" | "admin";
    toolName?: string;
    toolInput?: unknown;
    summary: string;
    model?: string;
    startedAt?: Date;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(auditEvents).values({ ...input, id, status: "pending" });
  return id;
}

export async function completeAction(
  db: Db,
  id: string,
  input: { status: "done" | "denied" | "expired" | "failed"; authority?: Authority; costUsd?: number; timings?: TurnTimings },
): Promise<void> {
  await db
    .update(auditEvents)
    .set({
      status: input.status,
      finishedAt: new Date(),
      ...(input.authority ? { authority: input.authority } : {}),
      ...(input.costUsd !== undefined ? { costUsd: input.costUsd.toString() } : {}),
      ...(input.timings ? { timings: input.timings } : {}),
    })
    .where(eq(auditEvents.id, id));
}

/** Stamps when the reply reached the chat onto the turn's message row. */
export async function recordSent(db: Db, id: string, sentAt: Date): Promise<void> {
  await db
    .update(auditEvents)
    .set({ timings: sql`${auditEvents.timings} || ${JSON.stringify({ sentAt: sentAt.toISOString() })}::jsonb` })
    .where(eq(auditEvents.id, id));
}

export async function recordAuthority(db: Db, id: string, authority: Authority): Promise<void> {
  await db.update(auditEvents).set({ authority }).where(eq(auditEvents.id, id));
}

export async function listActions(
  db: Db,
  filter: { tenantId: string; chatId?: string; definitionId?: string; personId?: string; personIds?: string[]; definitionIds?: string[]; status?: string; before?: string; /* id of the last row of the previous page */ limit?: number },
): Promise<AuditEvent[]> {
  if (filter.personIds?.length === 0 || filter.definitionIds?.length === 0) return [];
  const conditions = [eq(auditEvents.tenantId, filter.tenantId)];
  if (filter.chatId) conditions.push(eq(auditEvents.chatId, filter.chatId));
  if (filter.definitionId) conditions.push(eq(auditEvents.definitionId, filter.definitionId));
  if (filter.personId) conditions.push(eq(auditEvents.personId, filter.personId));
  if (filter.personIds) conditions.push(inArray(auditEvents.personId, filter.personIds));
  if (filter.definitionIds) conditions.push(inArray(auditEvents.definitionId, filter.definitionIds));
  if (filter.status) conditions.push(eq(auditEvents.status, filter.status));
  if (filter.before) {
    // Keyset cursor on (started_at, id), compared in SQL so microseconds are never truncated; an unknown id is ignored.
    const [c] = await db.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.id, filter.before), eq(auditEvents.tenantId, filter.tenantId)));
    if (c) conditions.push(sql`(${auditEvents.startedAt}, ${auditEvents.id}) < (select started_at, id from audit_events where id = ${filter.before} and tenant_id = ${filter.tenantId})`);
  }
  return db
    .select()
    .from(auditEvents)
    .where(and(...conditions))
    .orderBy(desc(auditEvents.startedAt), desc(auditEvents.id))
    .limit(filter.limit ?? 100);
}

/** Deletes finished rows older than the retention; pending rows are never touched. */
export async function pruneAudit(db: Db, tenantId: string, retentionDays: number, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const gone = await db
    .delete(auditEvents)
    .where(and(eq(auditEvents.tenantId, tenantId), isNotNull(auditEvents.finishedAt), lt(auditEvents.finishedAt, cutoff)))
    .returning({ id: auditEvents.id });
  return gone.length;
}

/** Prunes every tenant now and then every intervalMs; returns a stop function. Failures are logged, never thrown. */
export function startAuditPruning(db: Db, intervalMs: number, log: (line: string) => void = console.log): () => void {
  const run = async () => {
    try {
      const counts = [];
      for (const t of await db.select({ id: tenants.id, days: tenants.retentionDays }).from(tenants)) counts.push(`${t.id}=${await pruneAudit(db, t.id, t.days)}+${await pruneOverheard(db, t.id, t.days)}`);
      log(`audit prune: ${counts.join(" ")}`);
    } catch (err) {
      console.error("audit prune failed", err);
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs).unref();
  return () => clearInterval(timer);
}

// Graph tools act as a person: their audit keeps targets, recipients, subjects and file names, never message bodies or file content
const PRIVATE_GRAPH_FIELDS = new Set(["body", "content", "comment"]);

/** What the audit keeps of a tool call's arguments. */
export function auditInput<T>(toolName: string, input: T): T {
  if (!toolName.startsWith("mcp__m365__") || !input || typeof input !== "object") return input;
  return Object.fromEntries(Object.entries(input).filter(([k]) => !PRIVATE_GRAPH_FIELDS.has(k))) as T;
}

// shortcut: summaries are plain text cut at 200 characters, no redaction beyond Graph bodies; revisit if tool inputs carry secrets.
export function summarise(toolName: string, rawInput: unknown): string {
  const toolInput = auditInput(toolName, rawInput);
  const input = toolInput as Record<string, unknown> | null;
  if (toolName === "mcp__computer__bash") {
    return typeof input?.command === "string" ? input.command.slice(0, 200) : toolName;
  }
  // a connection call reads as "<connection>: <what was run>"
  const conn = /^mcp__connections__(ssh|sql|http)_(read|change)$/.exec(toolName);
  if (conn && typeof input?.name === "string") {
    const what = conn[1] === "http" ? `${String(input.method ?? "GET")} ${String(input.path ?? "")}` : String(input.command ?? input.query ?? "");
    return `${input.name}: ${what}`.slice(0, 200);
  }
  if (toolName.startsWith("mcp__")) {
    const tool = toolName.slice(toolName.lastIndexOf("__") + 2);
    return `${tool} ${JSON.stringify(toolInput)}`.slice(0, 200);
  }
  return toolName;
}
