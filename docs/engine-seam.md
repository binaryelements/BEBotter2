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

A future OpenAI-compatible engine will execute the loop itself. PR 2 adds an app-side MCP registry
(`listTools` + `callTool`); PR 3 adds `tools` and `callTool` to `EngineRunInput` and lets that engine
authorise, execute and complete each call through the same gate. The security property is the same in
both models: no tool call reaches a handler without `authoriseTool` first.

## Not in this branch

- `mcp-compat.ts` and the MCP client registry (PR 2)
- the OpenAI-compatible engine and provider profiles (PR 3)
- transcript persistence/compaction (PR 3)
- the gate reclassification of `bash`, `ssh_read`, `http_read` and `knowledge.write` (PR 2)
- `read-document.ts`, which still uses the SDK for a PDF document block (PR 3)

## Why `runner.ts` is smaller

The warm pool, the fingerprint, the resume retry and the SDK message mapping all left `runner.ts`. The
app-side code now reads as: build the turn, run it, record the result. That is the property later PRs
need: adding a provider changes `src/engine/openai.ts` and a profile, not the security path.
