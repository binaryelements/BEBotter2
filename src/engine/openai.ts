import OpenAI from "openai";
import type { ChatCompletionChunk, ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { Engine, EngineMessage, EngineResult, EngineRunInput, EngineTool } from "./engine.js";
import { FAILED_TEXT } from "./engine.js";
import { normaliseUsage, priceFor, resolveModel } from "./providers.js";
import type { NormalisedUsage, ProviderProfile, RawUsage } from "./providers.js";

export type ProviderKeys = Record<string, { apiKey: string; baseUrl?: string }>;

/** The slice of the OpenAI client the engine uses; a fake can stand in for it in tests. */
type ChatClient = {
  chat: {
    completions: {
      create: (body: Record<string, unknown>, opts?: { signal?: AbortSignal }) => Promise<AsyncIterable<ChatCompletionChunk>>;
    };
  };
};

type Call = { id: string; name: string; arguments: string };

const parseArgs = (raw: string): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

const toTool = (t: EngineTool): ChatCompletionTool => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.inputSchema as never },
});

/**
 * A compacted transcript may start with a tool result whose assistant tool-call message was dropped.
 * Chat Completions rejects that, so keep only complete assistant-tool-call groups.
 */
const sanitiseHistory = (history: EngineMessage[]): EngineMessage[] => {
  const out: EngineMessage[] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i]!;
    if (m.role === "assistant") {
      const calls = m.toolCalls ?? [];
      if (!calls.length) {
        out.push(m);
        continue;
      }
      const ids = new Set(calls.map((c) => c.id));
      const results: EngineMessage[] = [];
      let j = i + 1;
      while (j < history.length) {
        const next = history[j]!;
        if (next.role !== "tool" || !ids.has(next.toolCallId)) break;
        results.push(next);
        j++;
      }
      if (results.length === ids.size) out.push(m, ...results);
      i = j - 1;
      continue;
    }
    if (m.role === "tool") continue; // an orphan result, with no assistant call before it
    out.push(m);
  }
  return out;
};

const toMessage = (m: EngineMessage): ChatCompletionMessageParam => {
  if (m.role === "user") {
    if (!m.images?.length) return { role: "user", content: m.text };
    return {
      role: "user",
      content: [
        { type: "text", text: m.text },
        ...m.images.map((img) => ({ type: "image_url" as const, image_url: { url: `data:${img.mimeType};base64,${img.data}` } })),
      ],
    };
  }
  if (m.role === "assistant") {
    return {
      role: "assistant",
      content: m.text ?? null,
      ...(m.toolCalls?.length
        ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.input) } })) }
        : {}),
    };
  }
  return { role: "tool", tool_call_id: m.toolCallId, content: m.text };
};

/**
 * The OpenAI-compatible engine: one loop over Chat Completions, with the app executing every tool.
 * Provider differences live in `providers.ts`; this file only knows the wire format.
 */
export class OpenAICompatEngine implements Engine {
  private readonly clients = new Map<string, ChatClient>();

  constructor(
    private readonly opts: {
      providers: ProviderKeys;
      /** For tests: build a client for a provider instead of the real OpenAI one. */
      client?: (providerId: string, baseUrl: string, apiKey: string) => ChatClient;
    },
  ) {}

  async run(input: EngineRunInput): Promise<EngineResult> {
    const resolved = resolveModel(input.model);
    if (!resolved) return this.failure(input, `Unknown model ${input.model}`);
    const keys = this.opts.providers[resolved.provider.id];
    if (!keys?.apiKey) return this.failure(input, `No API key for ${resolved.provider.id}`);

    const client = this.client(resolved.provider, keys);
    const tools = input.tools.map(toTool);
    const messages: EngineMessage[] = sanitiseHistory(input.history);
    const openai: ChatCompletionMessageParam[] = [{ role: "system", content: input.systemPrompt }, ...messages.map(toMessage)];
    const usage: NormalisedUsage = { inputTokens: 0, outputTokens: 0 };
    let steps = 0;

    input.onAttemptStart?.();
    input.onEvent({ kind: "ready" });
    if (input.tools.length) input.onEvent({ kind: "tools", tools: input.tools.map((t) => t.name) });

    try {
      for (; steps < input.maxSteps; steps++) {
        if (input.signal.aborted) return this.result(input, messages, "aborted", usage, steps);
        const stream = await client.chat.completions.create(
          {
            model: resolved.model.id,
            messages: openai,
            ...(tools.length ? { tools, tool_choice: "auto" } : {}),
            stream: true,
            ...(resolved.provider.includeUsage === false ? {} : { stream_options: { include_usage: true } }),
            [resolved.provider.maxTokensField ?? "max_tokens"]: resolved.model.maxOutput,
            ...(resolved.provider.thinking ?? {}),
          },
          { signal: input.signal },
        );

        let text = "";
        const calls: Call[] = [];
        let stepUsage: RawUsage | undefined;
        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            text += delta.content;
            input.onEvent({ kind: "delta", text: delta.content });
          }
          for (const tc of delta?.tool_calls ?? []) {
            const i = tc.index ?? 0;
            const call = (calls[i] ??= { id: "", name: "", arguments: "" });
            if (tc.id) call.id = tc.id;
            if (tc.function?.name) call.name += tc.function.name;
            if (tc.function?.arguments) call.arguments += tc.function.arguments;
          }
          if (chunk.usage) stepUsage = chunk.usage as unknown as RawUsage;
        }
        const u = normaliseUsage(stepUsage);
        usage.inputTokens += u.inputTokens;
        usage.outputTokens += u.outputTokens;
        if (u.cachedInputTokens !== undefined) usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + u.cachedInputTokens;
        // a provider that omits the id still needs one to match the tool result
        calls.forEach((c, i) => {
          if (!c.id) c.id = `call_${steps}_${i}`;
        });

        if (!calls.length) {
          messages.push({ role: "assistant", text });
          openai.push({ role: "assistant", content: text });
          return this.result(input, messages, "text", usage, steps + 1);
        }

        messages.push({ role: "assistant", ...(text ? { text } : {}), toolCalls: calls.map((c) => ({ id: c.id, name: c.name, input: parseArgs(c.arguments) ?? {} })) });
        openai.push({
          role: "assistant",
          content: text || null,
          tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })),
        });

        for (const call of calls) {
          if (input.signal.aborted) return this.result(input, messages, "aborted", usage, steps);
          input.onEvent({ kind: "tool", toolName: call.name });
          const args = parseArgs(call.arguments);
          if (!args) {
            const message = "The tool arguments were not valid JSON. Call the tool again with valid JSON.";
            messages.push({ role: "tool", toolCallId: call.id, text: message, isError: true });
            openai.push({ role: "tool", tool_call_id: call.id, content: message });
            continue;
          }
          const decision = await input.authoriseTool(call.id, call.name, args);
          if (!decision.allow) {
            messages.push({ role: "tool", toolCallId: call.id, text: decision.message, isError: true });
            openai.push({ role: "tool", tool_call_id: call.id, content: decision.message });
            continue;
          }
          if (input.signal.aborted) return this.result(input, messages, "aborted", usage, steps);
          const result = await input.callTool(call.name, args, input.signal);
          if (input.signal.aborted) return this.result(input, messages, "aborted", usage, steps);
          const text = result.text || "(no output)";
          messages.push({ role: "tool", toolCallId: call.id, text, ...(result.isError ? { isError: true } : {}) });
          openai.push({ role: "tool", tool_call_id: call.id, content: text });
          if (result.images?.length) {
            const note = `Image returned by ${call.name}.`;
            messages.push({ role: "user", text: note, images: result.images });
            openai.push({
              role: "user",
              content: [
                { type: "text", text: note },
                ...result.images.map((img) => ({ type: "image_url" as const, image_url: { url: `data:${img.mimeType};base64,${img.data}` } })),
              ],
            });
          }
          await input.completeTool(call.id, result.isError ? "failed" : "done");
        }
      }
      return this.result(input, messages, "max-steps", usage, steps);
    } catch (err) {
      if (input.signal.aborted) return this.result(input, messages, "aborted", usage, steps);
      console.error("openai engine failed", err instanceof Error ? err.message : "unknown");
      return this.result(input, messages, "error", usage, steps);
    }
  }

  private client(provider: ProviderProfile, keys: { apiKey: string; baseUrl?: string }): ChatClient {
    const existing = this.clients.get(provider.id);
    if (existing) return existing;
    const baseUrl = keys.baseUrl ?? provider.baseUrl;
    const client = this.opts.client
      ? this.opts.client(provider.id, baseUrl, keys.apiKey)
      : (new OpenAI({ apiKey: keys.apiKey, baseURL: baseUrl, timeout: 120_000 }) as unknown as ChatClient);
    this.clients.set(provider.id, client);
    return client;
  }

  private result(input: EngineRunInput, messages: EngineMessage[], stopReason: EngineResult["stopReason"], usage: NormalisedUsage, steps: number): EngineResult {
    const resolved = resolveModel(input.model);
    const costUsd = resolved ? priceFor(resolved.model, usage) : 0;
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    const text = stopReason === "text" && last?.role === "assistant" ? (last.text ?? "") : FAILED_TEXT;
    return { text, messages, usage: { ...usage, costUsd }, steps, stopReason };
  }

  private failure(input: EngineRunInput, message: string): EngineResult {
    console.error(message);
    return { text: FAILED_TEXT, messages: sanitiseHistory(input.history), usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, steps: 0, stopReason: "error" };
  }
}
