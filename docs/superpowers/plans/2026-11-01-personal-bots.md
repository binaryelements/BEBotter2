# Personal Bots and Choosing a Bot in a Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each person who has the personal-bot flag gets their own assistant that acts as them in Microsoft 365 (mail, calendar, files, chats), and anyone who adds the app picks which bot they talk to from a card, switching any time.

**Architecture:** Bot definitions gain an identity (`service` or `person`). A tenant has one `Personal` definition (identity `person`); "a person's personal bot" is that definition running in that person's own one-to-one chat with their own Graph token and session. Graph access is a built-in MCP server in the service process (like `knowledge` and `connections`) that calls Microsoft Graph with the person's delegated token, obtained through the Agents SDK's user authorization (Azure Bot OAuth connection, Teams SSO). Writes go through the existing confirmation gate. A one-to-one chat's bot is chosen by the person from a card (an Adaptive Card action handled like the confirm card) and stored as the chat's assignment.

**Tech Stack:** Node 24, TypeScript, Express, Drizzle/Postgres (PGlite in tests), `@microsoft/agents-hosting` 1.9.1 (`AgentApplication` authorization handlers), Claude Agent SDK, Microsoft Graph v1.0 REST via `fetch`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-29-be-botter-2-design.md` sections 4.2 (identity, Graph capabilities, built-in `Personal` definition), 4.4 (personal bot), 4.3, and 4.13 (Martin, 2026-11-01: a card on install lists the bots the person may use, one click sets the chat, "switch" shows it again; addressing a bot by name per message comes next, not in this plan).

## Global Constraints

- No new npm dependencies. Graph via `fetch` with the delegated token; no Graph SDK.
- The person's token never reaches the model, the computer or the logs; it lives only in the service process for the call. Audit rows record targets, recipients, subjects, file names and a short summary, never bodies (spec 4.4).
- A personal bot acts only for its owner: only the owner may confirm its actions (spec 4.5), and it never runs in a group chat or in another person's chat.
- Graph writes always need confirmation in the chat: `send_mail`, `reply_mail`, `create_event`, `respond_event`, `upload_file`. Reads run freely. An admin may not set a Graph write to run freely (same lock as approve-class actions).
- Delegated Graph scopes: `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `Files.ReadWrite.All`, `Chat.Read`, `offline_access`. Nothing application-wide.
- Every migration is additive (the previous release keeps working while the new one starts).
- Copy is minimal, lowercase on buttons, per the design system; replies say who is answering.
- Tests offline: Graph and the token service are faked at the `fetch`/authorization boundary.

## Review Focus

1. A person without the personal-bot flag never sees "My assistant" on the card and cannot reach the Personal definition by any route (a forged card choice, an admin assigning Personal to a group chat).
2. Someone other than the owner clicks a personal bot's confirmation card (forwarded card, shared screen): refused.
3. The token expired or consent was withdrawn mid-conversation: the bot asks the person to sign in again and shows the sign-in card; no Graph call retries with a stale token; no token text reaches chat or logs.
4. The person chose a role bot, then lost access to it: the next message says so and shows the card again.
5. The person's personal chat and a group chat with a role bot run at once: separate sessions and engines; the Graph token is never available to the group chat's engine.

---

### Task 1: Identity, the Personal definition, and who may use it

**Files:** migration `drizzle/0010_*.sql` (+ meta); `src/db/schema.ts`; `src/bots/definitions.ts`; `src/admin/access.ts`; tenant bootstrap in `src/org/org.ts` and start-up in `src/main.ts`; tests alongside.

- `bot_definitions.identity text not null default 'service'` (`'service' | 'person'`), `bot_definitions.graph jsonb not null default '[]'` (capabilities `"mail.read" | "mail.send" | "calendar.read" | "calendar.write" | "chats.read" | "files.read" | "files.write"`).
- `ensurePersonalDefinition(db, tenantId): Promise<BotDefinition>` creates once per tenant `{ name: "personal", label: "My assistant", identity: "person", graph: all seven, computer: false, model: tenant default }` with persona (exact): "You are the personal assistant of the person you are talking to. You act as them in Microsoft 365: their mail, calendar, files and Teams chats. Be brief. Before you send, reply, book, accept or save anything, say exactly what you will do; the person confirms it in the chat." Called at tenant upsert and at start for existing tenants.
- `mayUseDefinition`: a `person` definition is usable only by a person whose `personal_bot` flag is on (department links ignored for it).
- `assignToChat` refuses a `person` definition for a chat that is not `personal`, or whose owner lacks the flag.
- [ ] Tests: created once per tenant; flag off → `mayUseDefinition` false, on → true; assigning Personal to a group chat throws; old rows read as `service`.
- [ ] Commit `feat(bots): identity and the built-in Personal definition`.

### Task 2: Choosing the bot in a one-to-one chat (card, switch)

**Files:** `src/teams/handlers.ts`, `src/teams/cards.ts`, `src/teams/app.ts`, `src/bots/definitions.ts` (`usableDefinitions(db, tenantId, personId)`), `src/db/schema.ts` (`chats.owner_person_id text null`, migration `0011`); tests.

- `usableDefinitions`: Personal first (if the flag is on), then service definitions the person may use, by label.
- Personal chat with no assignment: one usable definition → assign it and answer; several → send the card, no turn; none → "No bot is available to you yet. Ask an admin." On install in a personal chat, send the card instead of today's greeting when there are two or more.
- Card: "Who would you like to talk to?", one `Action.Execute` per usable definition (verb `choose`, data `{ definitionId }`), labelled `My assistant` for Personal, otherwise `<name> · <label>` or `<label>`.
- `choose`: only the chat owner; re-checks `mayUseDefinition`; replaces the chat's assignment; replies "You're now talking to <label>." and refreshes the card to show the choice. A message that is exactly `switch` (trimmed, any case) in a personal chat sends the card instead of a turn.
- Assigned definition no longer usable: "You no longer have access to <label>." plus the card.
- Group chats unchanged (admin assigns on Assignments).
- [ ] Tests: install with two usable bots sends the card; one answers directly; owner's `choose` sets the assignment; a `choose` the person may not use is refused and changes nothing; `switch` shows the card; lost access shows the card.
- [ ] Commit `feat(teams): pick the bot for a one-to-one chat from a card`.

### Task 3: Sign-in and the person's token

**Files:** `src/teams/app.ts` (authorization handler `graph`), `src/teams/handlers.ts`, `src/config/config.ts` (`GRAPH_OAUTH_CONNECTION`, default `graph`), `teams-app/manifest.json` (`webApplicationInfo`, version bump), `src/engine/runner.ts` (turn carries `graphToken?: () => Promise<string | undefined>`); tests.

- Only `person` turns ask for a token: `authorization.getToken(ctx, "graph")`; none → start sign-in (OAuth card / Teams SSO exchange); the pending message runs once on `onSignInSuccess`. Failure: "Sign-in didn't work. Say anything to try again." and the error code only in logs.
- The token is fetched per Graph call through the closure; never stored, never in options, prompts or audit.
- Routines of a personal bot get the owner's token through the adapter's user token client (owner's user id from the chat's conversation reference); none → the routine posts "Sign in again to let me run this routine." and stops. The implementer verifies the 1.9.1 API for a token outside a turn; if there is none, routines of personal bots are refused at creation with that reason (ruling in the ledger).
- Azure/Entra (controller with Martin, not code): Azure Bot OAuth connection `graph` (Azure AD v2, the bot's app registration, the scopes above, token exchange URL `api://botid-<appId>`); app registration "Expose an API" `api://botid-<appId>` with scope `access_as_user` and the Teams client IDs authorized; redirect `https://token.botframework.com/.auth/web/redirect`; admin consent.
- [ ] Tests (authorization faked): a person turn without a token sends the sign-in card and runs no engine; after sign-in the pending text runs once; a service turn never asks; the token never appears in engine options or audit rows.
- [ ] Commit `feat(teams): sign in once and act with the person's token`.

### Task 4: The Graph tools

**Files:** `src/graph/client.ts` (`fetch` wrapper: base `https://graph.microsoft.com/v1.0`, bearer from the closure, one retry on 429/503 honouring `Retry-After`, `GraphError(status, code)` without bodies), `src/graph/mcp.ts` (built-in MCP server `m365`), `src/engine/runner.ts` (add `m365` for `person` definitions, filtered by `definition.graph`), `src/engine/gate.ts` (writes confirm, locked); tests.

Compact JSON results (ids, subject, from, to, dates, preview ≤ 300 chars; bodies only from `read_mail`, ≤ 20 000 chars):
- mail.read: `search_mail { query, top≤25 }`, `list_mail { folder?: inbox|sent, top≤25 }`, `read_mail { id }`
- mail.send (write): `send_mail { to[], cc[]?, subject, body }`, `reply_mail { id, body, all?: boolean }`
- calendar.read: `list_events { from, to }` (≤ 31 days), `find_free_time { attendees[], from, to, minutes }`
- calendar.write (write): `create_event { subject, start, end, attendees[]?, online?: boolean, body? }`, `respond_event { id, response: accept|decline|tentative, comment? }`
- files.read: `search_files { query, top≤25 }`, `read_file { id }` (text formats; others give metadata and "not readable as text")
- files.write (write): `upload_file { folder, name, content }` (text, ≤ 4 MB)
- chats.read: `list_chats { top≤25 }`, `read_chat { id, top≤50 }`
- Write cards show recipients, subject, times, file name and the text, as the existing card does.
- [ ] Tests (fetch faked): each tool hits the right Graph path and maps the answer; a capability off hides its tools; writes need confirmation and an admin rule cannot free them; a Graph 401 becomes "sign in again" (Review Focus 3); errors never include the token.
- [ ] Commit `feat(graph): mail, calendar, files and chats as the person`.

### Task 5: Admin

**Files:** `src/admin/bots.ts`, `src/admin/people.ts`, `src/admin/overview.ts`; tests.

- Bot page for a `person` definition: Overview says "acts as each person who uses it"; a **Microsoft 365** tab with the seven capability checkboxes; no Email or Connections tab.
- People: the personal-bot column reads "My assistant" on/off; turning it off for someone whose one-to-one chat is on Personal clears that assignment so their next message shows the card.
- Bots list and Overview show Personal once, with how many people have it on.
- [ ] Tests: capabilities round-trip and hide tools; flag off clears the assignment; heads cannot change Personal's capabilities.
- [ ] Commit `feat(admin): Personal bot settings and the people switch`.

### Task 6: Deploy and try it (controller, with Martin)

- [ ] Azure/Entra setup from Task 3 on staging's app first; Martin grants consent; staging Teams package with `webApplicationInfo`.
- [ ] Staging: Martin adds the app, picks "My assistant", signs in, asks "what's on my calendar tomorrow?" and "draft a reply to the last email from Joy" (the card shows; nothing is sent until he confirms).
- [ ] Production: same Azure steps on the production app, consent, Teams package update, PR merge with Martin's approval.
