# The engine seam (PR 1)

This branch removes the Claude Agent SDK from `runner.ts` without changing behaviour. Claude is still the
engine; it now sits behind a neutral contract in `src/engine/engine.ts` and an adapter in
`src/engine/claude.ts`.

## What moved

| Before | After |
|---|---|
| `RunnerDeps.queryFn: typeof query` | `RunnerDeps.engine: Engine` |
| `RunnerDeps.live?: LiveSessions` | owned by `ClaudeEngine` |
| `runner.ts` built SDK `Options` | `ClaudeEngine` builds them |
| `runner.ts` read `SDKMessage` | `ClaudeEngine` maps to `EngineEvent` |
| `runner.ts` ran the resume/retry/live fallback | `ClaudeEngine` does |
| `TurnScope` held `canUseTool`/`afterTool` | `TurnContext` holds only app state; the engine gets `authoriseTool`/`completeTool` |

`runner.ts` still owns the prompt, the gate, the audit rows, the confirmation cards, the cost growth and
the stored session. `engineSetup` now returns provider-neutral `EngineProcessOptions` (model, system
prompt, MCP servers, max steps, cwd, web search) plus a fingerprint.

## The contract

```ts
type EngineRunInput = {
  model: string;
  systemPrompt: string;
  mcpServers: Record<string, unknown>;
  maxSteps: number;
  cwd: string;
  webSearch: boolean;
  key: string;              // chatId:definitionId, for a warm runtime
  fingerprint?: string;     // changes when the turn's options change
  history: EngineMessage[];
  checkpoint?: string;      // engine-private resume token
  useWarm?: boolean;        // false for a grant or a background job
  signal: AbortSignal;
  onEvent: (e: EngineEvent) => void;
  authoriseTool: (callId, name, input) => Promise<ToolDecision>;
  completeTool: (callId, status) => Promise<void>;
  onAttemptStart?: () => void;
  onAttemptEnd?: () => Promise<void>;
};
```

`EngineEvent` carries `ready` and `tools` as runtime facts, then `delta` / `text` / `tool` /
`message-end` as the reply is written. `EngineResult` carries the text, the neutral transcript, the
checkpoint, usage, steps and why it stopped.

## The two execution models

Claude Code executes tools itself. Its adapter therefore uses `authoriseTool` before each call and
`completeTool` from the PostToolUse hooks, and receives the app's MCP servers in `mcpServers`.

The OpenAI-compatible engine executes the loop itself. The app-side MCP registry
(`listTools` + `callTool`) is in `mcp-registry.ts`; `EngineRunInput` carries `tools` and `callTool`,
and that engine authorises, executes and completes each call through the same gate. The security
property is the same in both models: no tool call reaches a handler without `authoriseTool` first.

## The MCP layer (PR 2)

`src/engine/mcp.ts` is the shim: `tool()` and `createSdkMcpServer()` now build a real
`@modelcontextprotocol/sdk` `McpServer`, which is the same class the Claude Agent SDK's
`McpSdkServerConfigWithInstance` carries. The eight server files changed only their import line.

`src/engine/mcp-registry.ts` is the app's client: it connects in-process servers over
`InMemoryTransport`, configured servers over `StreamableHTTPClientTransport` or
`StdioClientTransport`, lists tools as `mcp__server__tool`, and maps a call's text and image
content to the neutral `McpToolResult`. It is created for one turn and closed at the end.

The gate now asks before `bash`, `ssh_read`, `http_read` and `knowledge.write`; an admin can
still set any of them free per bot.

## The OpenAI-compatible engine (PR 3)

`src/engine/providers.ts` is the model registry: `deepseek/deepseek-flash`, `deepseek/deepseek-v4-pro`,
`qwen/qwen3.8-max` and `qwen/qwen3.8-flash`, with context windows, output limits and list prices.
Adding a provider is a block there, not a new engine.

`src/engine/openai.ts` is one loop over Chat Completions: stream the reply, accumulate tool-call
arguments, authorise each call, execute it through `McpRegistry`, feed the result back, and repeat
until text or `maxSteps`. It sums usage per step, prices it from the profile, and turns an image tool
result into a user image message (OpenAI tool messages are text-only).

`src/engine/transcript.ts` keeps a long chat under the context limit: it folds the oldest messages
into a deterministic summary and keeps the recent window. The `sessions` row now stores `messages`,
`summary`, `input_tokens`, `output_tokens`, `provider` and `model`; `sdk_session_id` is nullable, so
Claude can keep its resume token while the new engine replays the neutral transcript.

`ENGINE=claude|openai` selects the engine. `DEFAULT_MODEL` is a Claude id for the first and a
`provider/model` slug for the second; the admin settings page accepts either.

## The last gaps (PR 4)

`read-document.ts` now extracts PDF text with `pdftotext` (poppler-utils in the image) and Office
files through the existing LibreOffice → PDF pipeline. No model is in the loop, so a document cannot
instruct anything, and an OpenAI-only deployment reads PDFs without an Anthropic key.

`mcp-pool.ts` keeps stdio MCP clients alive between turns. The browser is keyed per chat, so its
in-memory profile and cookies never reach another chat; a stateless server can be keyed per bot. The
pool is closed on SIGTERM.

`assertPublicUrl` in `connections/oauth.ts` requires https and refuses localhost, private, link-local
and IPv4-mapped addresses before `discover` fetches a model-chosen URL or posts to a server-supplied
registration endpoint.

## Not in this branch

- admin token usage display
- transcript encryption/retention (the handover's security item 4)
- the remaining security items (audit redaction, OAuth sign-in scope, attachment host allowlist)
- removing the SDK and the Claude engine (cutover)

## Why `runner.ts` is smaller

The warm pool, the fingerprint, the resume retry and the SDK message mapping all left `runner.ts`. The
app-side code now reads as: build the turn, run it, record the result. That is the property later PRs
need: adding a provider changes `src/engine/openai.ts` and a profile, not the security path.
