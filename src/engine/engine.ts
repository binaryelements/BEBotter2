import type { McpServerConfig } from "./mcp.js";

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
  | { kind: "ready" }
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
  usage: EngineUsage;
  steps: number;
  stopReason: "text" | "max-steps" | "aborted" | "error";
};

export type ToolDecision = { allow: true } | { allow: false; message: string };

/** A tool as the model sees it. */
export type EngineTool = { name: string; description: string; inputSchema: Record<string, unknown> };

/** What a tool call hands back: text for the transcript, and any image the model may look at. */
export type ToolResult = { text: string; isError?: boolean; images?: EngineImage[] };

/** What the app has built for one turn. */
export type EngineProcessOptions = {
  /** The bot's configured model id. */
  model: string;
  systemPrompt: string;
  /** MCP servers the app has built for this turn. */
  mcpServers: Record<string, McpServerConfig>;
  maxSteps: number;
  cwd: string;
  /** Whether the bot may use the provider's own web search tools. */
  webSearch: boolean;
};

export type EngineRunInput = EngineProcessOptions & {
  history: EngineMessage[];
  signal: AbortSignal;
  onEvent: (event: EngineEvent) => void;
  /** The tools the app offers; the engine calls `callTool` for each. */
  tools: EngineTool[];
  callTool: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
  /** The app's gate, audit row and confirmation card. */
  authoriseTool: (callId: string, name: string, input: Record<string, unknown>) => Promise<ToolDecision>;
  /** Closes the audit row opened by authoriseTool. */
  completeTool: (callId: string, status: "done" | "failed") => Promise<void>;
  /** Called before each attempt, so the app can reset per-attempt timings. */
  onAttemptStart?: () => void;
};

export interface Engine {
  run(input: EngineRunInput): Promise<EngineResult>;
}

/** A failed turn's reply; never leak provider error text into the chat. */
export const FAILED_TEXT = "I couldn't finish that.";
