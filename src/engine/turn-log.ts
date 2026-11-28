import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { turnLogs } from "../db/schema.js";
import { maskSecrets } from "../knowledge/secrets-scan.js";
import type { EngineMessage, EngineResult, RawExchange } from "./engine.js";
import { withoutImages } from "./transcript.js";

/** A tool result longer than this is cut: enough to read it, without one product search filling the table. */
export const TOOL_TEXT_MAX = 20_000;
export const TURN_LOG_DAYS = 30;

export type TurnLogInput = {
  tenantId: string;
  definitionId: string;
  chatId: string | null;
  workflow?: { runId: string; nodeId: string; stepStartedAt: string };
  startedBy: string;
  model: string;
  systemPrompt: string;
  /** The user message this turn added, as the model got it; it marks where sent ends and the reply begins. */
  prompt: string;
  result: Pick<EngineResult, "messages" | "usage" | "stopReason" | "error" | "raw">;
};

const cut = (text: string): string =>
  text.length <= TOOL_TEXT_MAX ? text : `${text.slice(0, TOOL_TEXT_MAX)}\n[cut: ${Math.ceil((text.length - TOOL_TEXT_MAX) / 1000)} KB more]`;

/** Every string in a tool input, masked; the shape is kept so it still reads as the call that was made. */
const maskDeep = (v: unknown): unknown =>
  typeof v === "string" ? maskSecrets(v) : Array.isArray(v) ? v.map(maskDeep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)])) : v;

/** A raw string as stored: image bytes become a note of their size, secret-looking values are masked. */
const rawString = (s: string): string => (/^data:[^;,]+;base64,/.test(s) ? `[image: ${Math.ceil(((s.length - s.indexOf(",") - 1) * 0.75) / 1000)} KB]` : maskSecrets(s));
const maskRaw = (v: unknown): unknown =>
  typeof v === "string" ? rawString(v) : Array.isArray(v) ? v.map(maskRaw) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskRaw(x)])) : v;

/** The exact calls as stored: the same masking and tool-result cut as the readable log, nothing else changed. */
export function forRaw(raw: RawExchange): RawExchange {
  const messages = raw.messages.map((m) => {
    const msg = m as { role?: string; content?: unknown };
    return msg.role === "tool" && typeof msg.content === "string" ? { ...msg, content: cut(msg.content) } : m;
  });
  return { request: maskRaw(raw.request) as RawExchange["request"], messages: maskRaw(messages) as unknown[], calls: maskRaw(raw.calls) as RawExchange["calls"] };
}

/** What is stored: no image bytes, long tool results cut, secret-looking values masked. */
export function forLog(messages: EngineMessage[]): EngineMessage[] {
  return withoutImages(messages).map((m) => {
    if (m.role === "user") return { ...m, text: maskSecrets(m.text) };
    if (m.role === "tool") return { ...m, text: maskSecrets(cut(m.text)) };
    return { ...m, ...(m.text !== undefined ? { text: maskSecrets(m.text) } : {}), ...(m.toolCalls ? { toolCalls: m.toolCalls.map((c) => ({ ...c, input: maskDeep(c.input) })) } : {}) };
  });
}

/** How many of the messages were sent: everything up to and including this turn's own user message. */
export function sentCountOf(messages: EngineMessage[], prompt: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && m.text === prompt) return i + 1;
  }
  return 0;
}

/** Saves the turn; returns its id, or undefined when saving failed (a log never fails the turn). */
export async function saveTurnLog(db: Db, t: TurnLogInput): Promise<string | undefined> {
  try {
    const id = crypto.randomUUID();
    await db.insert(turnLogs).values({
      id,
      tenantId: t.tenantId,
      definitionId: t.definitionId,
      chatId: t.chatId,
      ...(t.workflow ? { workflowRunId: t.workflow.runId, nodeId: t.workflow.nodeId, stepStartedAt: new Date(t.workflow.stepStartedAt) } : {}),
      startedBy: t.startedBy,
      model: t.model,
      systemPrompt: maskSecrets(t.systemPrompt),
      messages: forLog(t.result.messages),
      sentCount: sentCountOf(t.result.messages, t.prompt),
      raw: t.result.raw ? forRaw(t.result.raw) : null,
      stopReason: t.result.stopReason,
      error: t.result.error?.slice(0, 2000) ?? null,
      inputTokens: t.result.usage.inputTokens,
      outputTokens: t.result.usage.outputTokens,
      costUsd: String(t.result.usage.costUsd),
    });
    return id;
  } catch (e) {
    console.error("turn log:", e instanceof Error ? e.name : "error");
    return undefined;
  }
}

/** Links the log to the turn's message row once that row exists. */
export async function linkTurnLog(db: Db, id: string | undefined, auditId: string): Promise<void> {
  if (!id || !auditId) return;
  await db.update(turnLogs).set({ auditId }).where(eq(turnLogs.id, id)).catch((e) => console.error("turn log link:", e instanceof Error ? e.name : "error"));
}

/** Deletes a tenant's logs older than the retention. */
export async function pruneTurnLogs(db: Db, tenantId: string, days = TURN_LOG_DAYS, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const gone = await db.delete(turnLogs).where(and(eq(turnLogs.tenantId, tenantId), lt(turnLogs.createdAt, cutoff))).returning({ id: turnLogs.id });
  return gone.length;
}
