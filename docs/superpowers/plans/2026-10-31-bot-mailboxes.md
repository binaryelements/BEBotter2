# Bot Names and Mailboxes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every bot has a name and its own email address on BE AgentMail, created automatically, usable by the bot with confirmation on sends, and removable from the admin page.

**Architecture:** A small admin client for BE AgentMail's REST API (`src/mail/agentmail.ts`) creates an inbox, issues the bot's agent key and adds a `message.received` webhook; a `mailboxes` table holds the address, ids and the encrypted agent key and webhook secret. The runner attaches BE AgentMail's MCP endpoint as a built-in server `mail` with the bot's own key. An inbound route verifies the webhook and posts a notice in the bot's chats.

**Tech Stack:** Node 24, TypeScript strict ESM, Express, Drizzle, vitest, `@anthropic-ai/claude-agent-sdk` (http MCP servers), `@microsoft/agents-hosting` (proactive send).

**Spec:** `docs/superpowers/specs/2026-10-29-be-botter-2-design.md` section 4.11. BE AgentMail reference: Notion "BE Agent Mail — add email to your agent or system"; API at `https://agentmail.a.sapautomate.com` (`/openapi.json`, `/docs`).

## Global Constraints

- No new npm dependencies; migrations add-only.
- Secrets: the admin key comes from `.env` (`AGENTMAIL_ADMIN_KEY`); agent keys and webhook signing secrets are stored encrypted with the existing secrets key and never logged, returned to the model, or shown on a page. Never print or commit a real key; tests use fakes and an injected `fetchFn`.
- `AGENTMAIL_URL` defaults to `https://agentmail.a.sapautomate.com`; mailboxes are off when `AGENTMAIL_ADMIN_KEY` is unset (the service still starts).
- Nothing hard coded beyond these values; top-level `import type` only; tests offline.
- BE AgentMail facts: `POST /inboxes {local_part, display_name, owner_agent}`; `PATCH /inboxes/ID {active, display_name}`; `POST /agents/AGENT/keys {label}` returns `key` once and an id; `DELETE /agent-keys/ID`; `POST /agents/AGENT/webhooks {url, inbox?, events?}` returns `signing_secret` (`amwh_…`) once and an id; `DELETE /webhooks/ID`. Auth `Authorization: Bearer <admin key>`. MCP endpoint `<AGENTMAIL_URL>/mcp` with `Authorization: Bearer <agent key>`, tools `list_inboxes`, `list_messages`, `read_thread`, `search_mail`, `get_attachment`, `mark_read`, `send_email`, `reply_to_email`. Webhook headers `X-AgentMail-Timestamp`, `X-AgentMail-Signature` = hex HMAC-SHA256 of `timestamp + "." + raw body` with the signing secret; body `{id, type, agent, inbox, message{id, from_address, subject, …}}`; retries repeat `id`. Inboxes cannot be deleted. Check exact response field names against `/openapi.json` before relying on them.

## Review Focus

1. Two bots whose names give the same local part, or a name that clashes with an existing inbox: each gets a distinct address, and the first bot's mailbox is untouched.
2. BE AgentMail down or slow when a bot is created: the bot is still created and works; the mailbox is created on a later attempt (next save or service start) with no duplicate inbox.
3. A forged or replayed webhook (bad signature, old timestamp, repeated delivery id): ignored, nothing posted.
4. Removing a mailbox while the bot's engine is warm: the next turn has no `mail` server and the old key no longer works.
5. A mail notice never carries the mail body into the chat beyond sender and subject, and never starts a turn.

---

### Task 1: Name, mailbox table and BE AgentMail client

**Files:** Modify `src/db/schema.ts` (+ `pnpm db:generate`), `src/config/config.ts`, `.env.example`; Create `src/mail/agentmail.ts`, `src/mail/agentmail.test.ts`

**Interfaces:**
- `botDefinitions.displayName: text | null` (the bot's name).
- `mailboxes` table: `definitionId` (pk, references bot_definitions), `tenantId`, `agent`, `inboxId`, `address`, `keyId`, `keyCipher`, `webhookId`, `webhookSecretCipher`, `status` (`active` | `removed`), `createdAt`, `updatedAt` (ids and ciphers nullable so a half-finished create can be resumed).
- `config.agentmail?: { url: string; adminKey: string }`.
- `export function agentMailAdmin(cfg: { url: string; adminKey: string }, fetchFn: typeof fetch)` returning `{ createInbox(localPart, displayName, agent): Promise<{ id: string; address: string }>; setInboxActive(id, active): Promise<void>; setDisplayName(id, name): Promise<void>; issueKey(agent, label): Promise<{ id: string; key: string }>; revokeKey(id): Promise<void>; addWebhook(agent, url, inboxId): Promise<{ id: string; secret: string }>; removeWebhook(id): Promise<void>; inboxTaken(localPart): Promise<boolean> }`; non-2xx → `MailError` with status and a message that never includes a key.

- [ ] **Step 1: Tests** with a fake `fetchFn`: each call sends the admin Bearer header and the documented body; a non-2xx surfaces as `MailError`; responses are parsed into the shapes above; no error message contains the admin key or an issued key.
- [ ] **Step 2: Implement**; config reads `AGENTMAIL_URL` (default above) and `AGENTMAIL_ADMIN_KEY` (optional); `.env.example` gains both with placeholder values.
- [ ] **Step 3:** run the new test file and `src/config/config.test.ts`, typecheck, commit `feat(mail): bot names, mailbox table and BE AgentMail admin client`.

### Task 2: Mailboxes created, removed and restored

**Files:** Create `src/mail/mailboxes.ts`, `src/mail/mailboxes.test.ts`; Modify `src/bots/definitions.ts` (or where definitions are created/updated), `src/main.ts`

**Interfaces:** `ensureMailbox(deps: MailDeps, definitionId): Promise<Mailbox | undefined>`; `removeMailbox(deps, definitionId)`; `restoreMailbox(deps, definitionId)`; `ensureAllMailboxes(deps)` (startup backfill, one at a time, errors logged by name only). `MailDeps = { db; secretsKey; admin: ReturnType<typeof agentMailAdmin>; publicUrl }`.

- Local part: the bot's name, else its `name`, lowercased, characters outside `[a-z0-9._-]` → `-`, at most 36 chars; if taken (in our table or `inboxTaken`), append `-<definition name>`, then `-2`, `-3`…
- Agent name: `bb2-<first 12 chars of the definition id>` (one agent per bot, so a key reaches only its own inbox).
- Display name: `<name> (<label>)` when a name is set, else the label. Changing the name later updates the display name only; the address never changes.
- Webhook URL: `<publicUrl>/mail/inbound`, limited to the bot's inbox.
- Partial failure: whatever was created is recorded, so the next `ensureMailbox` finishes the job without a second inbox.
- Remove: revoke the key, delete the webhook, set the inbox inactive, `status = removed`. Restore: set active, issue a new key, add a new webhook, `status = active`.

- [ ] **Step 1: Tests** (fake admin client, PGlite): create path stores address and encrypted key; clash → suffixed address, other bot untouched; failure after `createInbox` then retry → no second `createInbox`; remove and restore call the right admin methods and flip status; backfill skips bots that already have one; mailboxes off (no admin) → no calls, no errors.
- [ ] **Step 2: Implement**; call `ensureMailbox` after a definition is created or saved (admin page and CLI), never failing the save; `ensureAllMailboxes` after the server starts.
- [ ] **Step 3:** run the touched test files one at a time, typecheck, commit `feat(mail): every bot gets its own mailbox`.

### Task 3: The bot uses its mail

**Files:** Modify `src/engine/runner.ts` (built-in servers, reserved names, fingerprint), `src/engine/gate.ts` (classification); Tests `src/engine/runner.test.ts`, gate tests

- Built-in MCP server `mail`: `{ type: "http", url: "<AGENTMAIL_URL>/mcp", headers: { Authorization: "Bearer <agent key>" } }` only when the bot's mailbox is `active`. `mail` joins the reserved names.
- Classification: `send_email`, `reply_to_email` are writes (confirmation card); every other tool of `mail` is a read.
- The mailbox status and key id are part of the live-engine fingerprint, so removing or restoring takes effect on the next turn.
- The bot's system prompt gains one line naming its name and address (from data) so it can say them.

- [ ] **Step 1: Tests:** active mailbox → `mail` server present with the bot's key; removed → absent; `send_email` asks for confirmation, `list_messages` does not; fingerprint changes when the mailbox is removed; a saved MCP server named `mail` is skipped.
- [ ] **Step 2: Implement. Step 3:** run touched files one at a time, typecheck, commit `feat(mail): bots read and send their own mail`.

### Task 4: Mail arriving

**Files:** Create `src/mail/inbound.ts`, `src/mail/inbound.test.ts`; Modify the Express wiring in `src/main.ts` (route before the admin router, raw body)

- `POST /mail/inbound`: find the mailbox by `agent`; verify `X-AgentMail-Signature` against the raw body with its stored secret (constant-time), timestamp within 5 minutes, delivery `id` not seen before; answer 200 quickly in all handled cases (401 on bad signature).
- Ignore mail whose sender address is on the domain of the bot's own address (bot-to-bot loops).
- Otherwise post in every chat the bot is assigned to: `New email to <address> from <sender>: <subject>` (subject trimmed to one line, 200 chars). No body, no turn started. Audit row with sender and subject.

- [ ] **Step 1: Tests:** good delivery → one notice per assigned chat; bad signature → 401, nothing posted; old timestamp, repeated id → ignored; sender on the mail domain → ignored; unknown agent → 200, nothing posted; the notice never contains the body.
- [ ] **Step 2: Implement. Step 3:** run the test file, typecheck, commit `feat(mail): tell the chat when mail arrives`.

### Task 5: Admin page

**Files:** Modify `src/admin/bots.ts`, `src/admin/router.ts`; Test `src/admin/bots.test.ts`

- Bot form gains **Name**. Bot page shows the address and status, with **Remove mailbox** (or **Restore mailbox**) behind the usual CSRF form, admins only, audited. No key or secret is ever rendered.
- [ ] **Step 1: Tests:** name saves and shows; address shows; remove and restore call the mailbox functions and redirect; a head or plain user gets 403; no page contains `bam_` or `amwh_`.
- [ ] **Step 2: Implement. Step 3:** run the test file, typecheck, commit `feat(admin): bot names and mailboxes`.

### Task 6: Deploy and live check (controller)

- [ ] `AGENTMAIL_ADMIN_KEY` added to `.env` from the key file without printing it; rebuild; the IT Support and Marketing bots get addresses at start.
- [ ] From the test inbox agent (`claude-code`), email the IT Support bot: a notice appears in the Teams chat. Ask the bot to read it and reply: the reply needs the card (Martin clicks), then arrives in the test inbox.
- [ ] Remove the mailbox on the admin page: the next turn has no mail tools and the old key gets 401. Restore it.
