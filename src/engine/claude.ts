import type { CanUseTool, HookCallback, Options, SDKMessage, SDKResultMessage, query } from "@anthropic-ai/claude-agent-sdk";
import type { Engine, EngineMessage, EnginePrewarmInput, EngineProcessOptions, EngineResult, EngineRunInput, ToolDecision } from "./engine.js";
import { FAILED_TEXT } from "./engine.js";
import { LiveSessions } from "./live.js";

const TRANSIENT = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET"]);

/** The last user message is the prompt: a resumed Claude session already holds the history before it. */
function promptOf(history: EngineMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role === "user") return m.text;
  }
  throw new Error("engine run needs a user message");
}

/**
 * The Claude Agent SDK behind the neutral Engine. It owns the SDK options, the warm process pool and
 * the resume token, so nothing above it imports the SDK.
 */
export class ClaudeEngine implements Engine {
  private readonly turns = new Map<string, EngineRunInput>();
  readonly live?: LiveSessions;

  constructor(
    private readonly queryFn: typeof query,
    opts: { live?: LiveSessions } = {},
  ) {
    this.live = opts.live;
  }

  async run(input: EngineRunInput): Promise<EngineResult> {
    const prompt = promptOf(input.history);
    input.onAttemptStart?.();

    if (this.live && input.useWarm !== false) {
      // a process already warm has no init message left to announce it, so say so before sending
      const warm = this.live.has(input.key);
      if (warm) input.onEvent({ kind: "ready", warm: true });
      try {
        const msg = await this.viaLive(input, prompt);
        return this.result(msg, input);
      } catch (err) {
        console.error("live engine failed, starting a cold one", err instanceof Error ? err.message : "unknown");
        await input.onAttemptEnd?.();
        input.onAttemptStart?.();
      }
    }

    const msg = await this.cold(input, prompt);
    if (!msg) throw new Error("Agent SDK query ended without a result");
    return this.result(msg, input);
  }

  async prewarm({ key, fingerprint, checkpoint, start, orphanTool }: EnginePrewarmInput): Promise<void> {
    if (!this.live) return;
    this.live.warm(key, fingerprint, () => this.options(start(), () => undefined, orphanTool, checkpoint));
  }

  reset(key: string): void {
    this.live?.close(key);
  }

  async close(): Promise<void> {
    await this.live?.closeAll();
  }

  private async viaLive(input: EngineRunInput, prompt: string): Promise<SDKResultMessage> {
    const live = this.live!;
    if (this.turns.has(input.key)) throw new Error("another turn is running on this live session");
    this.turns.set(input.key, input);
    try {
      return await live.send(
        input.key,
        input.fingerprint ?? "",
        () => this.options(input, () => this.turns.get(input.key), undefined, input.checkpoint),
        prompt,
        (m) => this.observe(m, input),
      );
    } finally {
      this.turns.delete(input.key);
    }
  }

  private async cold(input: EngineRunInput, prompt: string): Promise<SDKResultMessage | undefined> {
    let networkRetried = false;
    const once = async (): Promise<SDKResultMessage | undefined> => {
      const options = this.options(input, () => input, undefined, input.checkpoint);
      for await (const msg of this.queryFn({ prompt, options })) {
        this.observe(msg, input);
        if (msg.type === "result") return msg;
      }
      return undefined;
    };
    try {
      return await once();
    } catch (err) {
      const e = err as { code?: string; message?: string; cause?: { code?: string } };
      const code = e.cause?.code ?? e.code;
      if (networkRetried || !((code && TRANSIENT.has(code)) || e.message === "fetch failed")) throw err;
      networkRetried = true;
      console.warn("engine call failed, retrying once", code);
      await input.onAttemptEnd?.();
      input.onAttemptStart?.();
      return once();
    }
  }

  /**
   * The SDK options for one process. A live process outlives its turns, so `current` reads the turn
   * running now; with none, a tool call is refused and audited by `orphanTool`.
   */
  private options(
    proc: EngineProcessOptions,
    current: () => EngineRunInput | undefined,
    orphanTool: ((name: string, input: Record<string, unknown>) => Promise<ToolDecision>) | undefined,
    resume?: string,
  ): Options {
    const canUseTool: CanUseTool = async (toolName, input, { toolUseID }) => {
      const turn = current();
      const decision = turn ? await turn.authoriseTool(toolUseID, toolName, input) : await orphanTool!(toolName, input);
      return decision.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: decision.message };
    };
    const afterTool: HookCallback = async (hook) => {
      if (hook.hook_event_name !== "PostToolUse" && hook.hook_event_name !== "PostToolUseFailure") return {};
      await current()?.completeTool(hook.tool_use_id, hook.hook_event_name === "PostToolUse" ? "done" : "failed");
      return {};
    };
    return {
      model: proc.model,
      systemPrompt: proc.systemPrompt,
      cwd: proc.cwd,
      tools: proc.webSearch ? ["WebSearch", "WebFetch"] : [],
      allowedTools: [], // a tool named here bypasses canUseTool
      // runs code in the browser server's process, which can read this container's files and secrets
      disallowedTools: ["mcp__browser__browser_run_code_unsafe"],
      permissionMode: "default",
      settingSources: [],
      persistSession: true,
      includePartialMessages: true, // text as it is written, for streaming replies
      maxTurns: proc.maxSteps,
      // the model's process gets no service secrets, only what it needs to run
      env: Object.fromEntries(["PATH", "HOME", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"].filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
      mcpServers: proc.mcpServers,
      canUseTool,
      hooks: { PostToolUse: [{ hooks: [afterTool] }], PostToolUseFailure: [{ hooks: [afterTool] }] },
      ...(resume ? { resume } : {}),
    };
  }

  /** Maps SDK messages to the neutral events; a subagent's words are not the reply. */
  private observe(msg: SDKMessage, input: EngineRunInput): void {
    if (msg.type === "system" && msg.subtype === "init") {
      input.onEvent({ kind: "ready", warm: false });
      if (msg.tools?.length) input.onEvent({ kind: "tools", tools: msg.tools });
      return;
    }
    if (msg.type === "stream_event" && msg.parent_tool_use_id === null) {
      const e = msg.event;
      if (e.type === "content_block_delta" && e.delta.type === "text_delta") input.onEvent({ kind: "delta", text: e.delta.text });
      else if (e.type === "message_stop") input.onEvent({ kind: "message-end" });
      return;
    }
    if (msg.type !== "assistant") return;
    for (const block of msg.message.content) {
      if (block.type === "text") input.onEvent({ kind: "text", text: block.text });
      else if (block.type === "tool_use") input.onEvent({ kind: "tool", toolName: block.name });
    }
  }

  private result(msg: SDKResultMessage, input: EngineRunInput): EngineResult {
    const ok = msg.subtype === "success" && !msg.is_error;
    const text = ok && msg.subtype === "success" ? msg.result : FAILED_TEXT;
    return {
      text,
      messages: [...input.history, ...(ok ? [{ role: "assistant" as const, text }] : [])],
      checkpoint: msg.session_id,
      usage: {
        inputTokens: msg.usage?.input_tokens ?? 0,
        outputTokens: msg.usage?.output_tokens ?? 0,
        cachedInputTokens: msg.usage?.cache_read_input_tokens,
        costUsd: msg.total_cost_usd,
      },
      steps: msg.num_turns,
      stopReason: ok ? "text" : msg.subtype === "error_max_turns" ? "max-steps" : "error",
    };
  }
}
