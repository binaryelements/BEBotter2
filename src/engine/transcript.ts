import type { EngineMessage } from "./engine.js";

const CHARS_PER_TOKEN = 4;
const IMAGE_TOKENS = 1_000;
const SUMMARY_LIMIT = 4_000;
const MAX_MESSAGES = 40;

const textOf = (m: EngineMessage): string => {
  if (m.role === "user") return m.text;
  if (m.role === "assistant") return `${m.text ?? ""}${m.toolCalls ? JSON.stringify(m.toolCalls) : ""}`;
  return m.text;
};

/** A rough token count: four characters per token, plus a flat cost for each image. */
export function estimateTokens(messages: EngineMessage[]): number {
  return messages.reduce((n, m) => n + Math.ceil(textOf(m).length / CHARS_PER_TOKEN) + (m.role !== "assistant" && m.images?.length ? m.images.length * IMAGE_TOKENS : 0), 0);
}

/**
 * Keeps the recent window and folds the oldest messages into a summary. It is deterministic, not a
 * model call: enough to stop a long chat hitting the context limit, and cheap to test.
 */
export function compact(messages: EngineMessage[], summary: string | undefined, contextWindow: number): { messages: EngineMessage[]; summary?: string } {
  const limit = Math.floor(contextWindow * 0.6);
  const total = estimateTokens(messages);
  if (total <= limit && messages.length <= MAX_MESSAGES) return { messages, ...(summary ? { summary } : {}) };

  let drop = 0;
  let kept = total;
  while (messages.length - drop > 4 && (kept > limit || messages.length - drop > MAX_MESSAGES)) {
    kept -= Math.ceil(textOf(messages[drop]!).length / CHARS_PER_TOKEN);
    drop++;
  }
  // never start the kept window on a tool result; its assistant tool-call message must stay with it
  while (drop > 0 && messages[drop]?.role === "tool") drop--;
  const dropped = messages.slice(0, drop);
  const text = dropped.map((m) => `${m.role}: ${textOf(m)}`).join("\n");
  const joined = [summary, text].filter(Boolean).join("\n");
  const half = Math.floor((SUMMARY_LIMIT - 3) / 2);
  const next = joined.length <= SUMMARY_LIMIT ? joined : `${joined.slice(0, half)}\n…\n${joined.slice(-half)}`;
  return { messages: messages.slice(drop), ...(next ? { summary: next } : {}) };
}

/** Images are for the turn that saw them; keeping their bytes in the transcript would bloat the row. */
export const withoutImages = (messages: EngineMessage[]): EngineMessage[] =>
  messages.map((m) => (m.role !== "assistant" && m.images?.length ? { ...m, images: undefined } : m));
