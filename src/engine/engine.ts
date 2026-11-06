/**
 * The engine contract: one turn in, one turn out. It knows nothing about a provider's request shape,
 * only the app's policy callbacks and the MCP servers it may expose.
 */

/** An image a person's message or a tool result brings. */
export type EngineImage = { data: string; mimeType: string };

/** A provider-neutral transcript. Raw provider payloads are never stored. */
export type EngineMessage =
  | { role: "user"; text: string; images?: EngineImage[] }
  | { role: "assistant"; text?: string; toolCalls?: { id: string; name: string; input: unknown }[] }
  | { role: "tool"; toolCallId: string; text: string; isError?: boolean; images?: EngineImage[] };

/** `ready` and `tools` are runtime facts; the rest are the reply as it is written. */
export type EngineEvent =
  | { kind: "ready"; warm?: boolean }
  | { kind: "tools"; tools: string[] }
  | { kind: "text"; text: string }
  | { kind: "tool"; toolName: string }
  | { kind: "delta"; text: string }
  | { kind: "message-end" };

export type EngineUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd: number;
};

export type EngineResult = {
  text: string;
  messages: EngineMessage[];
  /** An engine-private resume token; the app stores it and hands it back unchanged. */
  checkpoint?: string;
  usage: EngineUsage;
  steps: number;
  stopReason: "text" | "max-steps" | "error";
};

export type ToolDecision = { allow: true } | { allow: false; message: string };

/** What the app has built for one turn, independent of who runs it. */
export type EngineProcessOptions = {
  /** The bot's configured model id. */
  model: string;
  systemPrompt: string;
  /** MCP servers for a runtime that executes tools itself. */
  mcpServers: Record<string, unknown>;
  maxSteps: number;
  cwd: string;
  /** Whether the bot may use the runtime's own web search tools. */
  webSearch: boolean;
};

export type EngineRunInput = EngineProcessOptions & {
  /** Identifies the conversation for a warm runtime; a stateless engine ignores it. */
  key: string;
  /** Changes when the turn's options change; a warm runtime with a different fingerprint starts again. */
  fingerprint?: string;
  history: EngineMessage[];
  checkpoint?: string;
  /** False for a run that must not share the chat's warm runtime (a grant or a background job). */
  useWarm?: boolean;
  signal: AbortSignal;
  onEvent: (event: EngineEvent) => void;
  /** The app's gate, audit row and confirmation card. */
  authoriseTool: (callId: string, name: string, input: Record<string, unknown>) => Promise<ToolDecision>;
  /** Closes the audit row opened by authoriseTool. */
  completeTool: (callId: string, status: "done" | "failed") => Promise<void>;
  /** Called before each attempt, so the app can reset per-attempt timings. */
  onAttemptStart?: () => void;
  /** Called when an attempt ends without a result, so the app can close unfinished audit rows. */
  onAttemptEnd?: () => Promise<void>;
};

export type EnginePrewarmInput = {
  key: string;
  fingerprint: string;
  checkpoint?: string;
  start: () => EngineProcessOptions;
  /** A tool call on a warm runtime with no turn running. */
  orphanTool: (name: string, input: Record<string, unknown>) => Promise<ToolDecision>;
};

export interface Engine {
  run(input: EngineRunInput): Promise<EngineResult>;
  /** Starts any warm runtime a turn on this key would use. */
  prewarm?(input: EnginePrewarmInput): Promise<void>;
  /** Drops a warm runtime whose stored session is being abandoned. */
  reset?(key: string): void;
  /** Stops every warm runtime. */
  close?(): Promise<void>;
}

/** A failed turn's reply; never leak provider error text into the chat. */
export const FAILED_TEXT = "I couldn't finish that.";
