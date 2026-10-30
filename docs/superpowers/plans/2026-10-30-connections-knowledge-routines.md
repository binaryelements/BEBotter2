# Connections, Knowledge and Routines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bots set up any connectivity a job needs (SSH, HTTP APIs, MCP servers) by walking staff through it in the chat, share an encrypted knowledge base, and run routines, checks and reminders on a schedule.

**Architecture:** Three new modules (`connections`, `knowledge`, `routines`), each with a store over Postgres and an in-process MCP server the engine runner attaches to every turn. Keys, API secrets and notes are encrypted with the existing `SECRETS_KEY` cipher. SSH runs from the service process with the system `ssh` client, a pinned host key and a throwaway key file; HTTP calls run from the service with the secret added there; approved MCP connections attach to linked bots like admin-added MCP servers. API secrets arrive through a one-time link, never the chat. A one-minute scheduler runs due routines through the same `runTurn` and posts results proactively. The confirmation gate gains a policy: who may confirm, and an `approve` class for admin/head-only approvals.

**Tech Stack:** Node 24, TypeScript strict ESM, Drizzle + Postgres (PGlite in tests), Express 4, `@anthropic-ai/claude-agent-sdk` `createSdkMcpServer`/`tool`, zod 4, OpenSSH client (`ssh`, `ssh-keygen`) in the app image. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-29-be-botter-2-design.md`, sections 4.2 (connections), 4.5 (confirmation), 4.6 (routines), 4.7 (audit), 4.8 (admin), 4.9 (bot-led setup), 4.10 (knowledge), 7 (security).

## Global Constraints

- Nothing hard coded (Martin, 2026-10-30): no per-OS setup scripts, no inventory checklists, no seeded routines or notes, no fixed list of system types in code. The bot writes instructions and decides what to record; schedules, prompts, timezone and notes are admin-editable data. Tool descriptions state facts and rules only.
- Any connectivity a job needs is set up by the bot when asked (Martin, 2026-10-30): `ssh`, `http` and `mcp` kinds in this plan; the kind is data, so later transports add a kind, not a new flow.
- No connection secret (private key, API key, token) ever enters a bot container, the model's context, the chat, the audit trail, a log line or an HTTP response. Only public keys are shown. Secrets are typed only into the one-time secret page.
- Secrets at rest use `encrypt`/`decrypt` from `src/secrets/cipher.ts` with `secretsKey`. No new key material.
- Every table row is tenant-scoped; every store function takes `tenantId` and filters by it.
- Migrations are add-only (`0002_*`): new tables and nullable/defaulted columns only.
- Copy is minimal; admin screens follow the existing `html`/`layout` style, CSRF field on every form, `wrap` for handlers, `DirectoryError` for 400s.
- Reserved MCP server names: `computer`, `knowledge`, `connections`, `routine`, and every name starting `conn-` (MCP connections attach as `conn-<connection name>`). Admin-added MCP servers may not use them.
- `import type` at top level only; no new dependencies; tests offline and deterministic (SSH and Docker behind interfaces; real-binary tests skip when the binary is missing).
- Commits end with the session attribution lines given in the dispatch.

## Review Focus

1. A target's host key changes after pinning → the connection goes `blocked`, the command does not run, and nothing re-pins silently (Task 4, Task 5).
2. Names, hosts or usernames starting with `-` or holding spaces, `@`, `;` or newlines → rejected before `ssh` is spawned (Task 4, Task 5); an `http_read`/`http_change` path that is absolute, protocol-relative or climbs out of the base URL → refused before any request (Task 7).
3. Two scheduler ticks, or two service instances, see the same due routine → it runs once (Task 8).
4. A knowledge write that contains a private key, a bearer token or `password: …` → refused, nothing stored, and the tool says why (Task 3).
5. A routine whose chat lost its bot assignment, whose conversation reference is missing, or whose definition was deleted → that run is recorded as failed, the scheduler carries on with the others (Task 9).

---

### Task 1: Schema, migration, reserved names

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/migrations/0002_*.sql` (+ meta snapshot/journal via `pnpm db:generate`)
- Modify: `src/bots/definitions.ts` (reserved names in `mcpServerInput`), `src/audit/audit.ts` (authority type)
- Test: `src/db/schema.test.ts`, `src/bots/definitions.test.ts`

**Interfaces:**
- Produces tables and types:
  - `connections`: `id` text pk, `tenantId` → tenants, `name` text (unique with tenantId), `kind` text (`ssh` | `http` | `mcp`), `target` text (host for `ssh`, base URL for `http`, server URL for `mcp`), `config` jsonb typed `ConnectionConfig` (`{ port: number; username: string }` for ssh; `{ auth?: { in: "header" | "query"; name: string; prefix?: string } }` for http; `{ headerName?: string; readOnlyTools: string[] }` for mcp), `mode` text (`read-only` | `change`), `status` text (`pending` | `awaiting-approval` | `active` | `blocked` | `revoked`), `secretCipher` text nullable (ssh private key or API secret; null until provided and after revoke), `publicKey` text nullable (ssh only), `hostKey` text nullable (ssh pinned key, e.g. `ssh-ed25519 AAAA…`), `requestedByPersonId` → people nullable, `approvedByPersonId` → people nullable, `createdAt`, `updatedAt`. Types `Connection`, `ConnectionConfig`.
  - `secretLinks`: `id` text pk, `tenantId`, `connectionId` → connections (cascade), `personId` → people, `tokenHash` text unique (sha256 hex of the token), `expiresAt`, `usedAt` nullable, `createdAt`.
  - `definitionConnections`: `definitionId` → botDefinitions, `connectionId` → connections (cascade), pk both.
  - `knowledgeVersions`: `id` text pk, `tenantId`, `path` text, `version` integer, `bodyCipher` text, `deleted` boolean default false, `authorPersonId` → people nullable, `authorDefinitionId` → botDefinitions nullable, `chatId` text nullable, `createdAt`; unique (`tenantId`, `path`, `version`). Type `KnowledgeVersion`.
  - `routines`: `id` text pk, `tenantId`, `definitionId` → botDefinitions, `chatId` → chats, `prompt` text, `schedule` text nullable (5-field cron), `runAt` timestamptz nullable (one-off), `quiet` boolean default false, `enabled` boolean default true, `grantPersonId` → people nullable (admin who granted `change`), `createdByPersonId` → people, `lastRunAt` timestamptz nullable, `createdAt`. Type `Routine`.
  - `tenants.timezone` text not null default `'UTC'`.
  - `auditEvents.authority` widens to `Authority = { type: "confirmation"; personId: string } | { type: "grant"; personId: string; routineId: string }`, exported from schema; `recordAuthority`/`completeAction` take `Authority`.
- Produces: `RESERVED_MCP_NAMES = ["computer", "knowledge", "connections", "routine"] as const` and `isReservedMcpName(name: string): boolean` (also true for any `conn-` prefix) in `src/bots/definitions.ts`.

- [ ] **Step 1: Write failing tests**
  - `schema.test.ts › "plan 3 tables exist after migrations"`: on `testDb()`, insert one row in each new table (with the needed tenant/person/chat/definition) and read it back; a new tenant's `timezone` equals `"UTC"`.
  - `schema.test.ts › "connection name is unique per tenant"`: second insert with same tenant+name throws; same name in another tenant succeeds.
  - `definitions.test.ts › "reserved MCP names are refused"`: `mcpServerInput.safeParse` fails for each of `knowledge`, `connections`, `routine`, `computer`, `conn-x` with a message containing `reserved`.
- [ ] **Step 2: Run** `pnpm vitest run src/db/schema.test.ts src/bots/definitions.test.ts` → FAIL.
- [ ] **Step 3: Implement** schema additions, `pnpm db:generate` (check the SQL is add-only), widen the authority type, replace the `"computer"` check with `RESERVED_MCP_NAMES`.
- [ ] **Step 4: Run** the same tests plus `pnpm tsc --noEmit` → PASS.
- [ ] **Step 5: Commit** `feat(db): connections, knowledge, routines tables`.

---

### Task 2: Confirmation policy and `approve` class

**Files:**
- Modify: `src/engine/confirm.ts`, `src/engine/gate.ts`, `src/engine/runner.ts`, `src/admin/access.ts`, `src/teams/handlers.ts`, `src/teams/app.ts`
- Test: `src/engine/confirm.test.ts`, `src/engine/gate.test.ts`, `src/admin/access.test.ts`, `src/teams/handlers.test.ts`, `src/engine/runner.test.ts`

**Interfaces:**
- `Outcome = { result: "confirmed"; personId: string } | { result: "denied" | "expired" }`
- `Confirmations.create(opts: { auditId: string; mayConfirm: (personId: string) => Promise<boolean>; ttlMs?: number }): { actionId: string; outcome: Promise<Outcome> }`
- `Confirmations.resolve(actionId: string, personId: string, answer: "yes" | "no"): Promise<"confirmed" | "denied" | "not_allowed" | "unknown">`
- `classify(toolName: string, def: BotDefinition, connectionServers: { name: string; readOnlyTools: string[] }[] = []): "read" | "write" | "approve"` — built-in tools, checked first: `mcp__knowledge__{list,read,search,write}` read; `mcp__connections__{list,request,verify,ssh_read,http_read}` read; `mcp__connections__{ssh_change,http_change}` write; `mcp__connections__approve` approve; `mcp__routine__{remind,post}` read; `mcp__computer__bash` read. Any other name on a reserved server → write. `conn-*` servers classify by the given `connectionServers` list (Task 7 passes the approved lists). Declared servers as today.
- `confirmerPolicy(db: Db, tenantId: string, definitionId: string, askerPersonId: string | null, kind: "write" | "approve"): (clickerPersonId: string) => Promise<boolean>` in `src/admin/access.ts`. `write`: clicker is the asker, an admin, or a head of a department allowed to use the definition. `approve`: admin, or head of a department allowed to use the definition. The clicker must belong to `tenantId`.
- `RunTurnInput` gains `routine?: { id: string; grantPersonId: string | null; post: (text: string) => Promise<void> }` (Task 7 fills it; here the gate reads `grantPersonId`).
- Runner gate: `read` → allow. `write` with `turn.routine?.grantPersonId` → allow, `recordAuthority({ type: "grant", personId: grantPersonId, routineId })`. Otherwise card with `mayConfirm = confirmerPolicy(db, tenantId, definition.id, person.id, kind)`; on confirm record `{ type: "confirmation", personId: <clicker> }`.
- SDK tool handlers do not receive the confirmation, so the runner remembers the person who confirmed the most recent approved call in this turn and passes a getter `confirmedBy(): string | undefined` to the built-in MCP server factories (Task 5's `approve` uses it). Turns run one at a time per chat and bot, and approved calls wait on their card, so the latest confirmer is the one for the running call.
- Card click text for `not_allowed`: `"You can't confirm this."`

- [ ] **Step 1: Write failing tests**
  - `confirm.test.ts › "a clicker the policy refuses gets not_allowed and the action stays pending"`; `› "an allowed clicker confirms and the outcome names them"`.
  - `access.test.ts › "write: asker, admin and allowed head may confirm; other user may not"`; `› "approve: a plain-user asker may not; admin and allowed head may"`; `› "clicker from another tenant is refused"`.
  - `gate.test.ts › "built-in tools classify as specified"` — table over every name above, plus `mcp__connections__other` → write, `mcp__conn-helpdesk__list_tickets` read when listed and write when not.
  - `runner.test.ts › "routine with a grant runs a write tool without a card and records grant authority"`; `› "approve-class tool asks for a card even with a grant"`; `› "confirmed write records the clicker as authority"`; `› "confirmedBy returns the clicker while the approved tool runs"`.
- [ ] **Step 2: Run** those files → FAIL.
- [ ] **Step 3: Implement.** `handleConfirmClick` becomes async; `app.ts` awaits it.
- [ ] **Step 4: Run** `pnpm test` → PASS (existing tests updated to the new signatures, not deleted).
- [ ] **Step 5: Commit** `feat(engine): confirmation policy, approve class, routine grants`.

---

### Task 3: Shared knowledge store and tools

**Files:**
- Create: `src/knowledge/store.ts`, `src/knowledge/secrets-scan.ts`, `src/knowledge/mcp.ts`
- Modify: `src/engine/runner.ts` (attach `knowledge` server every turn)
- Test: `src/knowledge/store.test.ts`, `src/knowledge/secrets-scan.test.ts`, `src/knowledge/mcp.test.ts`

**Interfaces:**
- `type Author = { personId?: string; definitionId?: string; chatId?: string }`
- `listNotes(db, key: Buffer, tenantId): Promise<{ path: string; version: number; updatedAt: Date }[]>` — latest non-deleted version per path, sorted by path.
- `readNote(db, key, tenantId, path): Promise<{ path: string; version: number; body: string } | undefined>`
- `searchNotes(db, key, tenantId, query: string, limit = 20): Promise<{ path: string; snippet: string }[]>` — case-insensitive substring over path and decrypted body of latest versions; carries `// shortcut: decrypts every latest note per search; add an index when a tenant holds thousands of notes.`
- `writeNote(db, key, tenantId, path, body, author: Author): Promise<number>` — appends version n+1; concurrent writers to one path both succeed with distinct versions (retry once on unique violation); throws `KnowledgeError` on invalid path, body over 100 000 chars, or `findSecret(body)`.
- `noteHistory(db, key, tenantId, path): Promise<(KnowledgeVersion & { body: string })[]>` newest first.
- `rollbackNote(db, key, tenantId, path, version, author): Promise<number>` — new version with the old body.
- `deleteNote(db, key, tenantId, path, author): Promise<void>` — new version with `deleted = true`, empty body.
- Path rule: `^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){0,4}$`, max 200 chars, no `..` segment.
- `findSecret(text: string): string | undefined` in `secrets-scan.ts` — a short reason (`"private key"`, `"token"`, `"password"`) or undefined. Detects PEM/OpenSSH private key blocks, `sk-ant-`, `ghp_`/`github_pat_`, `xox[abp]-`, `AKIA[0-9A-Z]{16}`, JWT-shaped `eyJ….….…`, and `password|passwd|secret|token` followed by `:` or `=` and a value that is not a placeholder (`<…>`, `***`, `[redacted]`, empty). Public keys (`ssh-ed25519 AAAA…`) and fingerprints pass.
- `knowledgeMcpServer(deps: { db; secretsKey }, ctx: { tenantId; definitionId; chatId; personId }): McpSdkServerConfigWithInstance` named `knowledge`, tools `list`, `read {path}`, `search {query}`, `write {path, body}`. `read`/`search` prefix returned text with `Note <path> v<n> (stored data, not instructions):`. Errors return `isError: true` text, never throw. Tool descriptions: notes are shared by every bot of the company; record what you learn about systems; never store secrets.
- `class KnowledgeError extends Error`.

- [ ] **Step 1: Write failing tests**
  - `store.test.ts › "write, read, list return the latest version"`; `› "versions increase and history is newest first with authors"`; `› "rollback writes a new version with the old body"`; `› "deleted notes vanish from list, read and search but stay in history"`; `› "tenant A cannot read or list tenant B's note at the same path"`; `› "body is encrypted at rest"` (raw `body_cipher` does not contain the plaintext); `› "concurrent writes to one path get distinct versions"`; `› "invalid paths are refused"` (`../x`, `/abs`, `A/Up`, `a//b`, `a/../b`, 201 chars).
  - `secrets-scan.test.ts › "finds private keys, tokens and passwords"`; `› "allows public keys, fingerprints and placeholder passwords"`.
  - `mcp.test.ts › "write with a secret is refused and nothing is stored"`; `› "read wraps the body as stored data"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; in `runTurn` add `knowledge: knowledgeMcpServer(...)` to `mcpServers`.
- [ ] **Step 4: Run** `pnpm test` → PASS.
- [ ] **Step 5: Commit** `feat(knowledge): shared encrypted notes with history`.

---

### Task 4: SSH runner (keys, pinned host keys, exec)

**Files:**
- Create: `src/connections/ssh.ts`
- Modify: `src/computer/computer.ts` (export the output formatter `runOnComputer` uses), `Dockerfile` (install `openssh-client` in the app image)
- Test: `src/connections/ssh.test.ts`

**Interfaces:**
- `formatOutput(r: { stdout: string; stderr: string; exitCode: number; timedOut: boolean }): string` exported from `src/computer/computer.ts`; `runOnComputer` uses it (same text and 20 000-char cap as today).
- `type SshTarget = { host: string; port: number; username: string; privateKey: string; hostKey: string | null }`
- `type SshResult = { output: string; exitCode: number; hostKey: string | null; hostKeyMismatch: boolean }`
- `interface SshRunner { generateKey(comment: string): Promise<{ privateKey: string; publicKey: string }>; exec(target: SshTarget, command: string, timeoutMs?: number): Promise<SshResult> }`
- `systemSsh(execFileImpl = execFile): SshRunner` — `generateKey` runs `ssh-keygen -t ed25519 -N "" -C <comment> -f <tmp>/key -q`. `exec` writes the key (mode 600) and, when pinned, the known_hosts line `[host]:port <hostKey>` into a fresh `mkdtemp` dir (mode 700) removed in `finally`; runs `ssh` without a shell: `-F /dev/null -i <key> -p <port> -l <username> -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=10 -o UserKnownHostsFile=<file> -o StrictHostKeyChecking=<yes when pinned, accept-new otherwise> -o LogLevel=ERROR -- <host> <command>`. After a first connect it reads the accepted key from the known_hosts file into `hostKey`. `hostKeyMismatch` is true when pinned and ssh exits 255 reporting a changed host key. Default timeout 120 s; output buffers capped (as `docker.ts` does).
- `fakeSsh(opts?: { hostKey?: string; mismatch?: boolean; output?: string }): SshRunner & { calls: { target: SshTarget; command: string }[] }` for other tasks' tests.
- `validTarget(t: { host: string; port: number; username: string }): string | undefined` — a reason when invalid. Host: DNS name labels, IPv4 or IPv6 literal, never starting with `-`. Username `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$`. Port integer 1–65535.

- [ ] **Step 1: Write failing tests**
  - `› "validTarget refuses option-like and malformed values"` (`-oProxyCommand=x`, `a b`, `a;b`, `u@h`, `x\n`, ports 0 and 70000; accepts `pve1`, `10.0.0.5`, `pve1.tail1234.ts.net`, `fd7a::1`).
  - `› "generateKey returns an OpenSSH ed25519 pair"` (skipped when `ssh-keygen` is not on PATH): private starts `-----BEGIN OPENSSH PRIVATE KEY-----`, public starts `ssh-ed25519 ` and ends with the comment.
  - `› "exec runs ssh without a shell and with the pinned-key options"` — fake `execFile` asserts argv holds `StrictHostKeyChecking=yes`, `-l`, `--`, the host after `--`, and that the temp dir is gone after success and after failure.
  - `› "exit 255 with a changed host key on a pinned target sets hostKeyMismatch"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(connections): ssh runner with pinned host keys`.

---

### Task 5: Connections store and the bot-led setup tools

**Files:**
- Create: `src/connections/store.ts`, `src/connections/mcp.ts`
- Modify: `src/engine/runner.ts` (attach `connections` server every turn; `RunnerDeps` gains `ssh: SshRunner`), `src/main.ts` (pass `systemSsh()`)
- Test: `src/connections/store.test.ts`, `src/connections/mcp.test.ts`

**Interfaces:**
- `requestConnection(db, ssh: SshRunner, key, tenantId, input: { kind: "ssh" | "http" | "mcp"; name; target; mode: "read-only" | "change"; config: ConnectionConfig; needsSecret?: boolean; definitionId; personId }): Promise<{ connection: Connection; publicKey?: string }>` — validates name `^[a-z0-9][a-z0-9-]{0,62}$` and the kind's target before any side effect (`ssh`: `validTarget`; `http`/`mcp`: absolute `https:` or `http:` URL without credentials or fragment; `mcp.readOnlyTools` names `^[A-Za-z0-9_-]+$`; `http.auth.name` an HTTP token). A non-revoked connection with that name in the tenant is returned as is and linked to `definitionId` (a different kind or target under that name is an error). `ssh` generates a key (comment `<definition name>@<connection name>`), stores it encrypted. Status `pending`.
- `listConnections(db, tenantId)`, `listConnectionsFor(db, tenantId, definitionId)`, `getConnection(db, tenantId, name)`.
- `verifyConnection(deps, tenantId, definitionId, name, probe?: { path: string }): Promise<{ status: Connection["status"]; output: string }>` — linked connections only. `ssh`: runs `exit 0`, first success pins `hostKey`, mismatch → `blocked`. `http` (Task 7) GETs `probe.path`; `mcp` (Task 7) lists tools. On success: `ssh` + `read-only` → `active`; anything else → `awaiting-approval`. Failure leaves status and returns the error text. A connection that needs a secret and has none returns "waiting for the secret".
- `approveConnection(db, tenantId, name, approverPersonId): Promise<void>` — only `awaiting-approval` → `active`, records `approvedByPersonId`.
- `runSsh(deps, tenantId, definitionId, name, command, mode): Promise<string>` — `ssh` kind, linked, `active`, and `connection.mode === mode` (each tool runs only on connections of its own mode); host-key mismatch → `blocked` and an error.
- `revokeConnection(db, tenantId, id): Promise<Connection>` (null `secretCipher`, status `revoked`, unused secret links deleted); `resetHostKey(db, tenantId, id)` (null `hostKey`, `blocked` → `pending`); `setLinked(db, tenantId, definitionId, connectionId, linked: boolean)`.
- `connectionsMcpServer(deps: { db; ssh; secretsKey; publicUrl; fetchFn }, ctx: { tenantId; definitionId; personId; confirmedBy: () => string | undefined }): McpSdkServerConfigWithInstance` named `connections`, tools: `list`; `request {kind, name, target, mode, port?, username?, auth?, headerName?, readOnlyTools?, needsSecret?}` returning facts only (name, kind, target, mode, status, public key for `ssh`, secret link for `http`/`mcp` when `needsSecret` — Task 6 supplies `createSecretLink`); `verify {name, probePath?}`; `approve {name}` (gate asks an admin or head; handler records `confirmedBy()`); `ssh_read {name, command}`; `ssh_change {name, command}`; `http_read`/`http_change` (Task 7). Descriptions state rules, not procedures: read-only use must not change anything; once active, map the system read-only and record it with the knowledge tools; never ask anyone to paste a password, key or token into the chat, send the secret link instead.
- Errors are `isError: true` text; no secret, cipher text or temp path appears in any result.

- [ ] **Step 1: Write failing tests** (with `fakeSsh`)
  - store: `› "ssh request creates a pending connection linked to the bot and returns only the public key"`; `› "a second request for the same name returns the same key"`; `› "verify pins the host key; read-only ssh becomes active, change awaits approval"`; `› "host key mismatch blocks the connection and runs nothing"`; `› "ssh_read on a change connection and ssh_change on a read-only connection are refused"`; `› "a bot not linked to the connection cannot verify or run on it"`; `› "revoke removes the secret and the connection cannot run"`; `› "tenant B cannot see or run tenant A's connection"`; `› "invalid names, option-like hosts and URLs with credentials are refused before any side effect"` (`fakeSsh.calls` empty, no row).
  - mcp: `› "no tool result contains the private key"` — every tool once; no output includes the fake private key or `BEGIN OPENSSH`.
  - mcp: `› "approve activates with the confirming person recorded"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test` → PASS.
- [ ] **Step 5: Commit** `feat(connections): bot-led setup, pinned keys, ssh tools`.

---

### Task 6: One-time secret link

**Files:**
- Create: `src/connections/secret-links.ts`, `src/admin/secret.ts`
- Modify: `src/admin/router.ts` (mount `/secret/:token` before the admin-only guard: any signed-in person of the tenant may reach it, the handler checks it is the link's person), `src/connections/mcp.ts` (`request` returns the link)
- Test: `src/connections/secret-links.test.ts`, `src/admin/secret.test.ts`

**Interfaces:**
- `createSecretLink(db, tenantId, connectionId, personId, publicUrl, now = new Date()): Promise<string>` — 32 random bytes base64url token, stores `sha256(token)` hex, `expiresAt = now + 30 min`, returns `${publicUrl}/admin/secret/${token}`. Earlier unused links for the same connection are deleted.
- `useSecretLink(db, key, tokenHashOf: string, personId, secret: string, now = new Date()): Promise<Connection>` — in one transaction with `FOR UPDATE`: the link exists, is unused, unexpired, belongs to `personId` and its tenant; marks used, stores `encrypt(key, secret)` in `secretCipher`. Secret 1–8000 chars, no CR/LF/NUL. Errors are `DirectoryError` with `"This link has expired or was already used."` or `"This link is for someone else."`.
- Routes: `GET /secret/:token` shows the connection name, kind and target and one password field + Save (CSRF); `POST /secret/:token` stores it and shows `"Saved. Tell the bot it's done."`. Sign-in uses the existing OIDC flow with return to this URL; the existing admin-only guard is not applied to these two routes, but the session and tenant checks are.

- [ ] **Step 1: Write failing tests**
  - `› "a link stores the secret encrypted once; a second use fails"`; `› "an expired link fails"`; `› "another person cannot use the link"`; `› "only the token hash is stored"`; `› "a plain user (not admin or head) can open and use their own link"`; `› "the page never echoes the secret"`; `› "without a session the page redirects to sign-in and back"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm test` → PASS.
- [ ] **Step 5: Commit** `feat(connections): one-time secret link`.

---

### Task 7: HTTP and MCP connections

**Files:**
- Create: `src/connections/http.ts`
- Modify: `src/connections/store.ts` (verify for `http`/`mcp`), `src/connections/mcp.ts` (`http_read`, `http_change`), `src/engine/runner.ts` (attach active `mcp` connections linked to the definition as `conn-<name>` servers with their secret header; pass their read-only lists to `classify`)
- Test: `src/connections/http.test.ts`, `src/connections/store.test.ts`, `src/engine/runner.test.ts`

**Interfaces:**
- `callHttp(fetchFn: typeof fetch, conn: { target: string; config: HttpConfig; secret?: string }, req: { method: string; path: string; query?: Record<string, string>; headers?: Record<string, string>; body?: string }, timeoutMs = 60_000): Promise<string>` — `path` must be relative (no scheme, no leading `//`, no `..` segment) and the resolved URL must keep the target's origin and start with its path; adds the secret as configured (header `name: prefix+secret` or query `name=secret`); request headers may not set the auth header, `Host`, `Cookie` or hop-by-hop headers; `redirect: "manual"` (a redirect is returned as text, not followed); body ≤ 100 000 chars; response text capped at 20 000 chars with status line first; the secret is replaced by `[secret]` in anything returned.
- `http_read {name, path, query?, headers?}` — `read-only` or `change` connection, GET/HEAD only. `http_change {name, method, path, query?, headers?, body?}` — `change` connection only, write class.
- Verify: `http` GETs the probe path the bot gives; `mcp` connects and lists tools with JSON-RPC `initialize` then `tools/list` POSTs over `fetchFn` (Streamable HTTP, secret header added; no new dependency) and returns the tool names.
- `connectionMcpConfigs(db, key, tenantId, definitionId): Promise<{ servers: Record<string, McpServerConfig>; readOnly: { name: string; readOnlyTools: string[] }[] }>` — active `mcp` connections linked to the definition.

- [ ] **Step 1: Write failing tests**
  - http: `› "adds the secret header and never returns the secret"`; `› "refuses absolute, protocol-relative and climbing paths"` (`https://evil`, `//evil`, `../x`, `a/../../x`); `› "refuses a caller-set auth or Host header"`; `› "does not follow redirects"`; `› "caps the response"`.
  - store: `› "http verify with a probe path moves to awaiting-approval"`; `› "mcp verify lists tools"`; `› "http_read refuses POST; http_change refuses a read-only connection"`.
  - runner: `› "an approved mcp connection is attached as conn-<name> and its listed tools run without a card"`; `› "a pending mcp connection is not attached"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm test` → PASS.
- [ ] **Step 5: Commit** `feat(connections): http and mcp connections`.

---

### Task 8: Cron matching, routines store, reminder tool

**Files:**
- Create: `src/routines/cron.ts`, `src/routines/store.ts`, `src/routines/mcp.ts`
- Modify: `src/org/org.ts` (`TenantSettings.timezone`), `src/engine/runner.ts` (attach `routine` server)
- Test: `src/routines/cron.test.ts`, `src/routines/store.test.ts`, `src/routines/mcp.test.ts`, `src/org/org.test.ts`

**Interfaces:**
- `parseCron(expr: string): Cron` (throws `Error` with a readable message) and `cronMatches(cron: Cron, at: Date, timeZone: string): boolean` — 5 fields (minute hour day-of-month month day-of-week), `*`, numbers, `a-b`, lists, `*/n`, `a-b/n`; day-of-week 0–7, 0 and 7 Sunday; when both day fields are restricted either may match. Local fields via `Intl.DateTimeFormat(…, { timeZone, hourCycle: "h23" })`.
- `validTimeZone(tz: string): boolean`.
- `TenantSettings` gains `timezone: string`; `setTenantSettings` throws `DirectoryError("Unknown time zone")` for invalid zones.
- `createRoutine(db, tenantId, input: { definitionId; chatId; prompt; schedule?: string; runAt?: Date; quiet?: boolean; grantPersonId?: string | null; createdByPersonId }): Promise<Routine>` — exactly one of `schedule`/`runAt`; schedule must parse; `runAt` in the future; prompt 1–4000 chars; the chat must have that definition assigned; `grantPersonId`, when set, must be an admin of the tenant. Errors are `DirectoryError`.
- `listRoutines(db, tenantId, definitionId?)`, `updateRoutine(db, tenantId, id, patch: Partial<Pick<Routine, "prompt" | "schedule" | "quiet" | "enabled" | "grantPersonId">>)`, `deleteRoutine(db, tenantId, id)`.
- `claimDue(db, now: Date): Promise<Routine[]>` — cron routines whose schedule matches `now`'s minute in their tenant's timezone and whose `lastRunAt` is before that minute's start; one-off routines with `runAt <= now` and `lastRunAt` null. Each is claimed with a conditional `UPDATE … SET last_run_at = <minute start> WHERE id = … AND (last_run_at IS NULL OR last_run_at < <minute start>) RETURNING *`; one-offs are set `enabled = false` in the same update. Returns only rows this call claimed.
- `routineMcpServer(deps: { db }, ctx: { tenantId; definitionId; chatId; personId; post?: (text: string) => Promise<void> }): McpSdkServerConfigWithInstance` named `routine`: `remind {at, prompt}` (`at` ISO 8601 with offset; one-off routine for this chat, creator = person; refuses past times and more than 366 days ahead) and, only when `post` is given, `post {text}`.

- [ ] **Step 1: Write failing tests**
  - cron: `› "matches the standard examples"` (`0 7 * * 1-5` Mon 07:00 local yes, Sat no; `*/15 * * * *`; `0 0 1 * *`; `30 2 * * 0` and `30 2 * * 7` both Sunday); `› "evaluates in the tenant time zone"` (`0 7 * * *` matches `2026-10-29T20:00Z` in `Australia/Sydney`); `› "rejects malformed expressions"` (`* * *`, `60 * * * *`, `a b c d e`).
  - store: `› "claimDue runs a cron routine once per matching minute"`; `› "two concurrent claimDue calls claim a routine once"`; `› "one-off routine runs once and is disabled"`; `› "a disabled routine is never claimed"`; `› "createRoutine refuses an unassigned chat, a past runAt, a bad schedule and a non-admin grant"`.
  - org: `› "settings refuse an unknown time zone"`.
  - mcp: `› "remind creates a one-off routine for this chat and refuses past times"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; runner adds `routine: routineMcpServer(...)` with `post: turn.routine?.post`.
- [ ] **Step 4: Run** `pnpm test` → PASS.
- [ ] **Step 5: Commit** `feat(routines): cron, store, reminders`.

---

### Task 9: Scheduler, headless runs, proactive posts

**Files:**
- Create: `src/routines/scheduler.ts`
- Modify: `src/teams/proactive.ts` (text or card), `src/teams/handlers.ts` (export the per-chat serialiser), `src/teams/app.ts` (construct a `CloudAdapter` and pass it as the application's `adapter`, so `startServer` and proactive sends share it), `src/main.ts` (start scheduler)
- Test: `src/routines/scheduler.test.ts`, `src/teams/proactive.test.ts`

**Interfaces:**
- `sendToChat(deps, chatId, message: string | AdaptiveCard): Promise<void>` (card → `MessageFactory.attachment(CardFactory.adaptiveCard(card))`).
- `serialize<T>(key: string, fn: () => Promise<T>): Promise<T>` exported from `src/teams/handlers.ts`; `handleMessage` and the scheduler both use it with key `${chatId}:${definitionId}`.
- `runRoutine(deps: { db; runTurn; send: (chatId: string, m: string | AdaptiveCard) => Promise<void> }, routine: Routine): Promise<void>` — loads definition, creator and chat, tenant-scoped; when the chat no longer has the definition assigned or it is gone, writes a `failed` message audit row naming the reason and returns. Runs `runTurn` with `text = routine.prompt`, `person = creator`, `routine: { id, grantPersonId, post }`, `askConfirmation` posting the card to the chat. Posts the final text unless `quiet` (role label in group chats, as `handleMessage` does). Send failures (e.g. missing conversation reference) are logged and audited, not thrown.
- `startScheduler(deps, intervalMs = 60_000, now = () => new Date()): () => void` — each tick `claimDue` then `runRoutine` for each claimed routine; errors logged, loop never stops; timer `unref`; logs `scheduler started` once.

- [ ] **Step 1: Write failing tests**
  - `› "a due routine runs once with its prompt and posts the reply to its chat"`.
  - `› "a quiet routine posts only what the bot posts through the post tool"`.
  - `› "a routine whose chat lost the bot is recorded failed and the next routine still runs"`.
  - `› "a routine waits for an in-flight chat turn on the same chat and bot"`.
  - `› "a granted routine's write is recorded with grant authority"` (real runner, fake query, Task 2's runner test helpers).
  - proactive: `› "sends a card as an adaptive card attachment"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; `main.ts` builds `send` from `sendToChat({ db, adapter: app.adapter, botAppId: config.teams.clientId }, …)` and starts the scheduler.
- [ ] **Step 4: Run** `pnpm test` → PASS.
- [ ] **Step 5: Commit** `feat(routines): scheduler and proactive posts`.

---

### Task 10: Admin — Knowledge screen

**Files:**
- Create: `src/admin/knowledge.ts`
- Modify: `src/admin/router.ts` (mount), `src/admin/html.ts` (nav link `Knowledge`)
- Test: `src/admin/knowledge.test.ts`

**Interfaces:**
- Routes: `GET /knowledge` (paths, version, updated; `?q=` search), `GET /knowledge/note?path=` (body in `<pre>`, history: version, author person name or bot label, chat label, time), `POST /knowledge/note` (admin; `path`, `body`), `POST /knowledge/rollback` (admin; `path`, `version`), `POST /knowledge/delete` (admin; `path`). Heads get the read pages without forms; their posts get 403. `KnowledgeError` → 400.

- [ ] **Step 1: Write failing tests** (pattern of existing `src/admin/*.test.ts` with `serve()`)
  - `› "admin creates, edits and rolls back a note; history shows three versions"`; `› "head reads notes but gets 403 on edit, rollback and delete"`; `› "a body with a private key is refused with 400 and nothing stored"`; `› "note bodies are escaped"`; `› "another tenant's admin sees none of the notes"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm test` → PASS.
- [ ] **Step 5: Commit** `feat(admin): knowledge screen`.

---

### Task 11: Admin — connections, routines, time zone

**Files:**
- Modify: `src/admin/bots.ts` (Connections and Routines sections on `/bots/:id`, admin only), `src/admin/settings.ts` (time zone field)
- Test: `src/admin/bots.test.ts`, `src/admin/settings.test.ts`

**Interfaces:**
- Connections section: the tenant's connections with name, kind, target, mode, status, whether a secret is held (never the secret) and a linked-to-this-bot toggle (`POST /bots/:id/connections/:connectionId/link`, `linked=on|off`); `Revoke` (`POST /connections/:connectionId/revoke`; for `ssh` the response page shows the public key line to remove from the target, for `http`/`mcp` it says to revoke the token at its source); `Reset host key` when `blocked` (`POST /connections/:connectionId/reset-host-key`). No create form: connections are set up from the chat.
- Routines section: prompt (first 80 chars), schedule or run time, chat label, quiet, enabled, grant holder; add form (`chatId` select of chats assigned this bot, `prompt`, `schedule`, `quiet`, `grant` checkbox → `grantPersonId = actor.personId`); per-row enable/disable and delete. Routes under `POST /bots/:id/routines…`, admin only.
- Settings: `timezone` text input.

- [ ] **Step 1: Write failing tests**
  - `› "admin links and unlinks a connection for a bot"`; `› "revoke shows the public key and the connection can no longer run"`; `› "reset host key moves a blocked connection back to pending"`; `› "admin creates a routine with a grant held by that admin"`; `› "routine with a bad cron is refused with 400"`; `› "head gets 403 on every connection and routine post"`; `› "settings save a valid time zone and refuse an unknown one"`; `› "no admin page contains BEGIN OPENSSH"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm test` → PASS.
- [ ] **Step 5: Commit** `feat(admin): connections, routines and time zone`.

---

### Task 12: Docs and live check (controller)

**Files:**
- Modify: `README.md` (connections, knowledge, routines; the app image carries `openssh-client`; targets must be reachable from the host's network, e.g. the tailnet)

- [ ] **Step 1:** README section; commit `docs: connections, knowledge, routines`.
- [ ] **Step 2:** `docker compose up -d --build app`; logs show migrations applied and `scheduler started`.
- [ ] **Step 3:** Live check in the IT Support chat against a throwaway `sshd` container on the dev VM: ask for read-only access, follow the bot's instructions, have it verify, ask a read-only question, see the note on the Knowledge screen and every call in Activity. Then ask it to connect to a throwaway HTTP echo service with a token: open the secret link, paste a dummy token, approve, make a read call. Ask for a reminder in two minutes; it arrives.
- [ ] **Step 4:** Revoke the test connection and remove the throwaway container.
