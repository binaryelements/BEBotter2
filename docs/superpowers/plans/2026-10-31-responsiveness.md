# Responsiveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bots answer faster, show what they are doing while they work, and every turn's timing is recorded.

**Architecture:** The runner reports progress events and phase timestamps through callbacks on `RunTurnInput`. A `LiveSessions` pool keeps one Agent SDK process per chat and bot alive between turns (streaming input), so the SDK and MCP servers start once instead of every message. The Teams handler turns progress events into one status message that is edited in place and finally becomes the reply.

**Tech Stack:** Node 24, TypeScript strict ESM, `@anthropic-ai/claude-agent-sdk` (`query` with `AsyncIterable<SDKUserMessage>` prompt), `@microsoft/agents-hosting` 1.9.1 (`sendActivity`, `updateActivity`), Drizzle, vitest.

**Spec:** `docs/superpowers/specs/2026-10-29-be-botter-2-design.md` (4.7 activity, audit). Requested by Martin 2026-10-31 after a 23 s reply: "1 and 2 is good" (1 = turn timing in Activity, 2 = keep the engine warm) and "is there a way to show some message of what it is doing to the user side as well".

Measured baseline (2026-10-31, one personal-chat turn): message received → first tool call 16 s, two tool calls 1 s, reply 5 s; about 23 s total.

## Global Constraints

- No new npm dependencies. Migrations add-only (previous release must keep working).
- Nothing hard coded: progress text comes from the model's own words or the tool's name, never a per-tool phrase table.
- Full chat text is not stored (Martin did not ask for it); timings and summaries only.
- A routine run under an admin grant keeps its own fresh session and never uses a live session.
- Never print secrets; logs carry chat ids, durations, counts and tool names only.
- Top-level `import type` only. Tests offline and deterministic; run one test file at a time.

## Review Focus

1. A group chat where two people write while a turn is running: the second message queues behind the first (existing `serialize`), and each reply edits its own status message.
2. Confirmation cards during a live session: the card still reaches the chat, the right person is checked as confirmer, and a 10-minute wait does not kill the live process or another chat's turn.
3. A definition edited on the admin page, or a connection approved, while a live session is open: the next turn uses the new persona, tools and connections.
4. The live process dies mid-turn (crash, OOM): the turn falls back once to a cold run and the user still gets an answer.
5. Fast replies (under 3 s) show no status message flicker; slow replies show the status message within 3 s.

---

### Task 1: Turn timing

**Files:**
- Modify: `src/db/schema.ts` (`auditEvents`: add nullable `timings jsonb`), generate migration with `pnpm db:generate`
- Modify: `src/engine/runner.ts`, `src/teams/handlers.ts`, `src/teams/app.ts`
- Modify: admin Activity screen (where message rows are listed) to show total seconds and the breakdown
- Test: `src/engine/runner.test.ts`, `src/teams/handlers.test.ts`, the Activity screen's test

**Interfaces:**
- `RunTurnInput.receivedAt?: Date` (set by the Teams app when the activity arrives; routines set the scheduled run time).
- `RunTurnInput.progress?: (event: ProgressEvent) => void` where `export type ProgressEvent = { kind: "text"; text: string } | { kind: "tool"; toolName: string }` (exported from `src/engine/runner.ts`; Task 3 consumes it).
- `export type TurnTimings = { receivedAt: string; engineReadyAt?: string; firstOutputAt?: string; firstToolAt?: string; resultAt?: string; sentAt?: string; tools: number; live?: boolean }` (ISO strings).
- `RunResult.timings: TurnTimings`.

- [ ] **Step 1: Tests.** runner: with a fake `queryFn` that yields a `system`/`init` message, an assistant message with a text block, an assistant message with a `tool_use` block, then `result`, the message audit row's `started_at` equals `receivedAt`, its `timings` has `engineReadyAt <= firstOutputAt <= firstToolAt <= resultAt`, `tools: 1`; `progress` is called with `{kind:"text"}` then `{kind:"tool", toolName}` in that order. handlers: after `send`, `sentAt` is written to the same audit row, and one log line `turn <chatId> <total>ms ready=<ms> first=<ms> tools=<n>` is printed (no message text).
- [ ] **Step 2: Implement.** Record each timestamp as the SDK messages stream past in `once`. Pass `receivedAt` from `app.ts` (`new Date()` at the top of the message handler). `beginAction` for the message row takes an optional `startedAt`. Add a small `recordSent(db, auditId, sentAt)` (or return the audit id in `RunResult` and complete it after sending) — one source of truth for the row.
- [ ] **Step 3: Activity screen** shows for message rows: total (received → sent) and `ready / first output / tools / reply` in seconds; rows without `timings` (older) show as before.
- [ ] **Step 4:** Run the touched test files one at a time, typecheck; commit `feat(audit): record turn timings`.

### Task 2: Live sessions

**Files:**
- Create: `src/engine/live.ts`, `src/engine/live.test.ts`
- Modify: `src/engine/runner.ts`, the built-in MCP server factories it calls (`knowledgeMcpServer`, `connectionsMcpServer`, `routineMcpServer`, `computerMcpServer` if needed), `src/main.ts` (or wherever deps are composed)

**Interfaces:**
- `export class LiveSessions { constructor(queryFn: typeof query, opts: { idleMs: number; max: number }); send(key: string, fingerprint: string, start: () => Options, text: string, onMessage: (m: SDKMessage) => void): Promise<SDKResultMessage | undefined>; close(key: string): void; closeAll(): Promise<void> }`
- `RunnerDeps.live?: LiveSessions` — when absent, the runner behaves exactly as today (tests and routines with a grant).
- Constants: `idleMs` 10 minutes, `max` 20 live sessions (least recently used closed first). These are operational limits, not behaviour.

- [ ] **Step 1: Tests for `LiveSessions`** with a fake `queryFn` whose prompt is an async iterable: two `send` calls on one key start `queryFn` once and each resolves with its own `result`; a different fingerprint closes the old process and starts a new one; idle timeout closes it (fake timers); `max` evicts the least recently used; if the stream throws or ends mid-turn, `send` rejects and the key is closed so the next `send` starts fresh.
- [ ] **Step 2: Implement `LiveSessions`.** One `query({ prompt: pushQueue, options: start() })` per key; `send` pushes an `SDKUserMessage` and reads the shared iterator until the next `result`. Closing ends the push queue and calls `interrupt()` / `return()` on the query.
- [ ] **Step 3: Per-turn state behind getters.** Everything the SDK options capture that changes per turn — the asking person, `askConfirmation`, `routine.post`, `progress`, `inFlight`/`granted`/approve bookkeeping, `confirmedBy` — is read through one mutable `current` turn object set at the start of each turn, so `canUseTool`, hooks and in-process MCP servers built at process start act for the person of the turn now running. Turns on one key never overlap (existing `serialize`).
- [ ] **Step 4: Fingerprint** = definition id + `updatedAt`, the connection set (ids, statuses, read-only tool lists from `connectionMcpConfigs`), computer container id. Any change starts a new process on the next turn (resuming the stored SDK session id, so the conversation continues).
- [ ] **Step 5: Runner wiring.** When `deps.live` is set and the turn is not a granted routine run, use `live.send`; on a rejected `send`, fall back once to today's cold path. Session id storage, auditing, retries and `changed` stay as they are. Close all live sessions on shutdown.
- [ ] **Step 6: Tests in `runner.test.ts`:** two turns from two different people on one live key: the second turn's `canUseTool` audit row and confirmer policy use the second person; a definition `updatedAt` change between turns starts a new process; a granted routine run never calls `live.send`.
- [ ] **Step 7:** Run the touched test files one at a time, typecheck; commit `feat(engine): keep the engine warm per chat`.

### Task 3: Progress in Teams

**Files:**
- Modify: `src/teams/handlers.ts`, `src/teams/app.ts`
- Test: `src/teams/handlers.test.ts`

**Interfaces:**
- `handleMessage(deps, msg, io)` where `io = { send(text): Promise<string | undefined /* activity id */>; update(activityId, text): Promise<void>; sendCard(card): Promise<void> }` (replaces the two positional callbacks).
- Consumes `ProgressEvent` from Task 1.

- [ ] **Step 1: Tests** (fake timers, fake io): a turn that finishes in under 3 s sends only the reply (no status message); a slower turn sends one status message after 3 s whose text is the model's latest text event (trimmed to one line, at most 200 chars) or, when it has said nothing yet, `Working: <tool name without the mcp__ prefix>…`; later events update that same message at most once every 2 s; at the end the status message is updated into the reply (group chats keep the role label); if `update` fails the reply is sent as a new message; a confirmation card is still sent as its own message.
- [ ] **Step 2: Implement** in `handleMessage`, with `update` in `app.ts` via `ctx.updateActivity({ ...MessageFactory.text(text), id })`. Keep `startTypingTimer: true`.
- [ ] **Step 3:** Run `src/teams/handlers.test.ts`, typecheck; commit `feat(teams): show what the bot is doing`.

### Task 4: Deploy and live check (controller)

- [ ] `docker compose up -d --build app`; in the 1:1 chat send two messages a minute apart: the second turn's `ready` time in Activity is well under the first's; a slow question shows a status line that turns into the answer; Activity shows timings for both turns.

---

## Part 2 (Martin, 2026-10-31, after the baseline): "yes streaming and the other fixes as well"

Baseline (Teams, warm engine, loaded VM): cold first message 22.7 s (engine ready 14.7 s); warm 10.7 s; trivial warm 4.1 s; web search 22.9 s. Reply delivery after the answer was ready: 1.1–5.3 s. Goal: first words on screen in about 3–5 s in 1:1 chats, the first message after idle no longer pays the engine start, and the reply goes out as soon as it is ready.

### Task 5: Reply goes out at once

**Files:** Modify `src/teams/handlers.ts`; Test `src/teams/handlers.test.ts`

- [ ] **Step 1: Tests:** when the turn ends while a throttled status update is queued, the queued update is dropped and the final reply is sent with no 2 s wait; when a status `send`/`update` is still in flight, the reply waits only for that one call (never for a queued one); the `turn …` log line gains `deliver=<ms>` (result → sent).
- [ ] **Step 2: Implement** in the status-message code from Task 3. **Step 3:** run the file, typecheck, commit `fix(teams): send the reply as soon as it is ready`.

### Task 6: Engine already warm

**Files:** Modify `src/engine/live.ts`, `src/main.ts` (or where LiveSessions is built), `src/engine/runner.ts` if a warm-up entry point is needed; Tests `src/engine/live.test.ts`, `src/engine/runner.test.ts`

**Interfaces:** `export function prewarm(deps: RunnerDeps, key: { tenantId: string; chatId: string; definitionId: string }): Promise<void>` in `src/engine/runner.ts` — starts the live process for that chat+bot with the same options a turn would use (resuming the stored session), without sending a message. LiveSessions gets `warm(key, fingerprint, start)` which starts a process without a turn.

- [ ] **Step 1: Tests:** `warm` starts `queryFn` once and a following `send` on the same key and fingerprint reuses it; `warm` on a key that is already live does nothing; a warm process counts toward `max` and idles out like any other; prewarm failures are logged and never throw.
- [ ] **Step 2: Implement.** Idle time becomes 60 minutes (was 10). On service start, prewarm chats whose session was updated in the last 60 minutes, most recent first, at most `max`. A prewarmed process uses the same per-turn identity rules as Task 2 (no person until a turn sets one; a tool call outside a turn is denied).
- [ ] **Step 3:** run the touched files one at a time, typecheck, commit `feat(engine): warm the engine before the first message`.

### Task 7: Streaming replies in 1:1 chats

**Files:** Modify `src/engine/runner.ts` (`includePartialMessages`, a `ProgressEvent` for text deltas), `src/engine/live.ts` if messages need passing through, `src/teams/handlers.ts`, `src/teams/app.ts`; Tests `src/engine/runner.test.ts`, `src/teams/handlers.test.ts`

**Interfaces:** `ProgressEvent` gains `{ kind: "delta"; text: string }` (text as the model writes it) and `{ kind: "message-end" }` (an assistant message finished). The Teams `io` gains an optional `stream?: { informative(text: string): void; chunk(text: string): void; end(finalText: string): Promise<void> }`, built in `app.ts` from `ctx.streamingResponse` (`queueInformativeUpdate`, `queueTextChunk`, `setFinalMessage` + `endStream`), offered only for personal chats.

- [ ] **Step 1: Check the SDKs first** (`node_modules/@microsoft/agents-hosting/dist/src/app/streaming/streamingResponse.d.ts` and `.js`, `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` near `includePartialMessages`): whether `streamingResponse` works with `longRunningMessages: true`, whether `setFinalMessage` replaces the streamed text, any stream time limit, and how often it sends. Write what you find in the report; if streaming cannot work with long-running messages, stop and report BLOCKED with the evidence.
- [ ] **Step 2: Tests:** in a personal chat, deltas reach `stream.chunk` as they arrive and the final message is exactly the reply text (`setFinalMessage`); text the model writes before a tool call is shown as an informative update, not left in the reply; a confirmation card ends the stream with the text so far and the reply after the card goes out as a new message (Task 3 ruling); if any stream call throws, the turn falls back to the Task 3 status message and the user still gets exactly one reply; group chats never stream and keep the status message; `sentAt` and the `turn …` log line are recorded on the streamed path too.
- [ ] **Step 3: Implement.** Text deltas of an assistant message are held until it is clear whether a tool call follows in that message; once the message ends without a tool call, its held text and later deltas stream as chunks. Keep the typing indicator until the first chunk.
- [ ] **Step 4:** run the touched files one at a time, typecheck, commit `feat(teams): stream replies in one-to-one chats`.

### Task 8: Deploy and measure again (controller)

- [ ] Rebuild; in the 1:1 chat repeat the four baseline messages after a restart (the first should be prewarmed only if the chat was active in the last hour, so send one message, restart, wait 30 s, then run the set); record first-words time from the Teams message timestamps and the `turn …` lines; check the engine processes close after 60 minutes idle and none are left behind.
