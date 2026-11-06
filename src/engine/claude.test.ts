import { describe, expect, it } from "vitest";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeEngine } from "./claude.js";
import { FAILED_TEXT } from "./engine.js";
import type { EngineEvent, EngineRunInput } from "./engine.js";

const runInput = (overrides: Partial<EngineRunInput> = {}): EngineRunInput => ({
  model: "claude-test",
  systemPrompt: "You are a test.",
  mcpServers: {},
  maxSteps: 25,
  cwd: "/tmp",
  webSearch: false,
  key: "c:d",
  fingerprint: "f",
  history: [{ role: "user", text: "hi" }],
  signal: new AbortController().signal,
  onEvent: () => {},
  authoriseTool: async () => ({ allow: true }),
  completeTool: async () => {},
  ...overrides,
});

function fakeEngine(messages: unknown[]) {
  const seen: Options[] = [];
  const queryFn = (({ options }: { options: Options }) => {
    seen.push(options);
    return (async function* () {
      for (const message of messages) yield message;
    })();
  }) as unknown as typeof query;
  return { engine: new ClaudeEngine(queryFn), seen };
}

describe("ClaudeEngine", () => {
  it("maps the SDK's messages to neutral events and result fields", async () => {
    const events: EngineEvent[] = [];
    const { engine, seen } = fakeEngine([
      { type: "system", subtype: "init", tools: ["mcp__knowledge__read"], session_id: "s-1" },
      { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "He" } } },
      { type: "stream_event", parent_tool_use_id: null, event: { type: "message_stop" } },
      { type: "assistant", message: { content: [{ type: "text", text: "Hello" }, { type: "tool_use", id: "t1", name: "mcp__knowledge__read", input: {} }] } },
      { type: "result", subtype: "success", result: "Hello", session_id: "s-1", total_cost_usd: 0.02, num_turns: 2, is_error: false, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 } },
    ]);

    const result = await engine.run(runInput({ checkpoint: "s-0", onEvent: (e) => void events.push(e) }));

    expect(events).toEqual([
      { kind: "ready", warm: false },
      { kind: "tools", tools: ["mcp__knowledge__read"] },
      { kind: "delta", text: "He" },
      { kind: "message-end" },
      { kind: "text", text: "Hello" },
      { kind: "tool", toolName: "mcp__knowledge__read" },
    ]);
    expect(result).toMatchObject({
      text: "Hello",
      checkpoint: "s-1",
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 3, costUsd: 0.02 },
      steps: 2,
      stopReason: "text",
      messages: [{ role: "user", text: "hi" }, { role: "assistant", text: "Hello" }],
    });
    expect(seen[0]).toMatchObject({ model: "claude-test", systemPrompt: "You are a test.", maxTurns: 25, cwd: "/tmp", resume: "s-0", includePartialMessages: true });
  });

  it("keeps an error turn out of the chat and reports why it stopped", async () => {
    const { engine } = fakeEngine([
      { type: "result", subtype: "error_max_turns", session_id: "s-1", total_cost_usd: 0, num_turns: 3, is_error: true, usage: { input_tokens: 1, output_tokens: 0 } },
    ]);

    const result = await engine.run(runInput());

    expect(result).toMatchObject({ text: FAILED_TEXT, stopReason: "max-steps", steps: 3, messages: [{ role: "user", text: "hi" }] });
  });

  it("passes a denied tool call back to the SDK with the app's message", async () => {
    const { engine, seen } = fakeEngine([{ type: "result", subtype: "success", result: "Done.", session_id: "s-1", total_cost_usd: 0, num_turns: 1, is_error: false, usage: { input_tokens: 0, output_tokens: 0 } }]);

    await engine.run(runInput({ authoriseTool: async () => ({ allow: false, message: "Not done: declined." }) }));

    const decision = await seen[0]!.canUseTool!("mcp__tickets__close_ticket", { id: 7 }, { signal: new AbortController().signal, toolUseID: "tu-1" } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
    expect(decision).toEqual({ behavior: "deny", message: "Not done: declined." });
  });
});
