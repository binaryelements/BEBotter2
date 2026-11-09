import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import { FAILED_TEXT } from "./engine.js";
import type { EngineEvent, EngineMessage, EngineRunInput } from "./engine.js";
import { OpenAICompatEngine } from "./openai.js";

const chunk = (delta: unknown, usage?: unknown): ChatCompletionChunk =>
  ({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: null }], ...(usage ? { usage } : {}) }) as ChatCompletionChunk;

function fakeClient(steps: ChatCompletionChunk[][]) {
  let i = 0;
  const bodies: Record<string, unknown>[] = [];
  return {
    bodies,
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          bodies.push(JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
          return (async function* () {
            for (const c of steps[i++] ?? []) yield c;
          })();
        },
      },
    },
  };
}

const input = (overrides: Partial<EngineRunInput> = {}): EngineRunInput => ({
  model: "deepseek/deepseek-flash",
  systemPrompt: "You are a test.",
  mcpServers: {},
  maxSteps: 5,
  cwd: "/tmp",
  webSearch: false,
  history: [{ role: "user", text: "hi" }],
  signal: new AbortController().signal,
  onEvent: () => {},
  tools: [{ name: "mcp__knowledge__read", description: "Read a note.", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
  callTool: async () => ({ text: "note body" }),
  authoriseTool: async () => ({ allow: true }),
  completeTool: async () => {},
  ...overrides,
});

const toolCall = (args = '{"path":"x"}') => chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "mcp__knowledge__read", arguments: args } }] });

describe("OpenAICompatEngine", () => {
  it("runs a tool call, feeds the result back and returns the final text", async () => {
    const events: EngineEvent[] = [];
    const authorise = vi.fn(async () => ({ allow: true as const }));
    const call = vi.fn(async () => ({ text: "note body" }));
    const complete = vi.fn(async () => {});
    const engine = new OpenAICompatEngine({
      providers: { deepseek: { apiKey: "k" } },
      client: () => fakeClient([[toolCall(), chunk({}, { prompt_tokens: 10, completion_tokens: 5 })], [chunk({ content: "Done." }), chunk({}, { prompt_tokens: 20, completion_tokens: 3 })]]),
    });

    const result = await engine.run(input({ onEvent: (e) => void events.push(e), authoriseTool: authorise, callTool: call, completeTool: complete }));

    expect(result).toMatchObject({ text: "Done.", stopReason: "text", steps: 2, usage: { inputTokens: 30, outputTokens: 8 } });
    expect(result.usage.costUsd).toBeGreaterThan(0);
    expect(authorise).toHaveBeenCalledWith("call_1", "mcp__knowledge__read", { path: "x" });
    expect(call).toHaveBeenCalledWith("mcp__knowledge__read", { path: "x" }, expect.any(AbortSignal));
    expect(complete).toHaveBeenCalledWith("call_1", "done");
    expect(events).toEqual([
      { kind: "ready" },
      { kind: "tools", tools: ["mcp__knowledge__read"] },
      { kind: "tool", toolName: "mcp__knowledge__read" },
      { kind: "delta", text: "Done." },
    ]);
    expect(result.messages).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", toolCalls: [{ id: "call_1", name: "mcp__knowledge__read", input: { path: "x" } }] },
      { role: "tool", toolCallId: "call_1", text: "note body" },
      { role: "assistant", text: "Done." },
    ]);
  });

  it("turns a denied call into a tool error and carries on", async () => {
    const call = vi.fn();
    const complete = vi.fn();
    const engine = new OpenAICompatEngine({
      providers: { deepseek: { apiKey: "k" } },
      client: () => fakeClient([[toolCall()], [chunk({ content: "Not done." })]]),
    });

    const result = await engine.run(input({ authoriseTool: async () => ({ allow: false, message: "Not done: declined." }), callTool: call, completeTool: complete }));

    expect(call).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(result.messages).toContainEqual({ role: "tool", toolCallId: "call_1", text: "Not done: declined.", isError: true });
    expect(result.text).toBe("Not done.");
  });

  it("stops at maxSteps and reports it", async () => {
    const engine = new OpenAICompatEngine({
      providers: { deepseek: { apiKey: "k" } },
      client: () => fakeClient(Array.from({ length: 3 }, () => [toolCall("{}")])),
    });

    const result = await engine.run(input({ maxSteps: 2 }));

    expect(result).toMatchObject({ text: FAILED_TEXT, stopReason: "max-steps", steps: 2 });
  });

  it("asks the model to retry malformed arguments without authorising a call", async () => {
    const authorise = vi.fn();
    const engine = new OpenAICompatEngine({
      providers: { deepseek: { apiKey: "k" } },
      client: () => fakeClient([[toolCall("{")], [chunk({ content: "Retried." })]]),
    });

    const result = await engine.run(input({ authoriseTool: authorise }));

    expect(authorise).not.toHaveBeenCalled();
    expect(result.messages).toContainEqual({ role: "tool", toolCallId: "call_1", text: expect.stringContaining("valid JSON"), isError: true });
    expect(result.text).toBe("Retried.");
  });

  it("carries an image result as a user message the model can see", async () => {
    const engine = new OpenAICompatEngine({
      providers: { deepseek: { apiKey: "k" } },
      client: () => fakeClient([[toolCall('{"id":"a"}')], [chunk({ content: "I see it." })]]),
    });

    const result = await engine.run(input({ callTool: async () => ({ text: "", images: [{ data: "aGVsbG8=", mimeType: "image/png" }] }) }));

    expect(result.messages).toContainEqual({ role: "user", text: "Image returned by mcp__knowledge__read.", images: [{ data: "aGVsbG8=", mimeType: "image/png" }] });
  });

  it("drops an orphan tool message before sending the history", async () => {
    const fake = fakeClient([[chunk({ content: "ok" })]]);
    const engine = new OpenAICompatEngine({ providers: { deepseek: { apiKey: "k" } }, client: () => fake });
    const history: EngineMessage[] = [
      { role: "user", text: "hi" },
      { role: "tool", toolCallId: "missing", text: "orphan" },
      { role: "user", text: "again" },
    ];

    const result = await engine.run(input({ tools: [], history }));

    expect((fake.bodies[0]!.messages as { role: string }[]).map((m) => m.role)).toEqual(["system", "user", "user"]);
    expect(result.messages).toEqual([
      { role: "user", text: "hi" },
      { role: "user", text: "again" },
      { role: "assistant", text: "ok" },
    ]);
  });

  it("keeps a complete assistant tool call and its result", async () => {
    const fake = fakeClient([[chunk({ content: "ok" })]]);
    const engine = new OpenAICompatEngine({ providers: { deepseek: { apiKey: "k" } }, client: () => fake });
    const history: EngineMessage[] = [
      { role: "user", text: "hi" },
      { role: "assistant", toolCalls: [{ id: "c1", name: "x", input: {} }] },
      { role: "tool", toolCallId: "c1", text: "result" },
      { role: "user", text: "again" },
    ];

    await engine.run(input({ tools: [], history }));

    expect((fake.bodies[0]!.messages as { role: string }[]).map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
  });

  it("fails cleanly for an unknown model or a missing key", async () => {
    const unknown = await new OpenAICompatEngine({ providers: {} }).run(input({ model: "nope/nope" }));
    expect(unknown).toMatchObject({ text: FAILED_TEXT, stopReason: "error", steps: 0 });
    const noKey = await new OpenAICompatEngine({ providers: {} }).run(input());
    expect(noKey).toMatchObject({ text: FAILED_TEXT, stopReason: "error", steps: 0 });
  });
});
