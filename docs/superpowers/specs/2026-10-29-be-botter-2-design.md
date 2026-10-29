# BE Botter 2: design

Date: 2026-10-29. Status: draft for Martin's approval. Nothing is built until this is approved.

Lines marked **[M]** are Martin's decisions, taken from the brainstorm. Lines marked **[C]** are the
writer's (Claude's) calls, made so a builder can plan; Martin may overrule any of them.

## 1. Intent

BE Botter 2 is a BE-branded product that puts specialised bots into Microsoft Teams. A company's
people talk to an IT Support bot, a Marketing bot, or their own personal bot, in the group chats and
one-to-one chats they already use. The bots watch their chats, answer when asked, chime in when
useful, remind, and do real jobs: mail, calendar, files, infrastructure, web, anything an MCP server
exposes. Each has its own computer. **[M]**

Why now: the previous attempt, the BE Botter fork of Rakazo, has a web app front end and a codebase
Martin found too messy to control and too hard to deploy. Teams is the only front end here, the
code is our own, and the agent behaviour (asking, clarifying, doing) is not written by us but comes
from the Claude Agent SDK. **[M]**

## 2. Goals, non-goals, anti-goals

Goals
- A customer's admin installs one Teams app and, from an admin web page, defines bots, people,
  departments and which bots live in which chats. **[M]**
- Bots act through confirmed actions: send mail, book meetings, save files, run commands, call MCP
  tools, and run scheduled checks. **[M]**
- Every bot action is in an audit trail. **[M]**
- Pre-configured Microsoft sign-in: one admin consent per tenant, silent for everyone after. **[M]**
- Lean: small codebase, few moving parts, deploys with one compose file. **[M]**

Non-goals (not in version one)
- A web chat, desktop or mobile client. Teams is the front end. **[M]**
- Non-Claude models. The engine is Claude only. **[M]**
- Separate Teams identities per bot role (see 4.3); it is a later option. **[C]**
- A public Teams store listing. Org-catalogue install first. **[C]**
- Voice, calls, meeting transcription. **[C]**

Anti-goals (would make it a failure even if it worked)
- A bot that changes something without a person's authority: a confirmation in the chat, or for
  a routine, an admin's standing grant.
- A bot that stores mail or file contents beyond the current conversation. **[C]**
- A customer admin having to touch Entra for more than: creating the Azure Bot registration (or
  letting BE do it with delegated admin access), installing the app, and consenting.
- Business logic for "how an agent behaves" written by us.

## 3. Constraints

- Engine: Claude Agent SDK, TypeScript (`@anthropic-ai/claude-agent-sdk`). Claude models only, via
  the Anthropic API. The product carries BE's name; "Claude" and "Rakazo" never appear to users.
  Anthropic's commercial terms apply. **[M]**
- Teams integration: Microsoft 365 Agents SDK (`@microsoft/agents-hosting`), one Azure Bot
  registration. The spike proved the round trip on 2026-10-29 (section 6). **[C]**
- Hosting: one service, Docker Compose, on BE's Coolify host, behind HTTPS. Bot computers are
  containers on the same host to start. **[C]**
- Data: Postgres. Secrets encrypted at rest with a key from the environment. **[C]**
- Security-sensitive: delegated Microsoft Graph tokens, SSH keys and MCP credentials. Treated as
  such throughout (section 7).
- The repo `binaryelements/BEBotter2` is private. **[C]** Still: no secrets, no customer data, no
  real company names in code or history.

## 4. The product

### 4.1 Tenants and people

- A **tenant** is one customer's Microsoft 365 organisation. Every table is keyed by tenant.
  **[C]** The first tenant is BE's own. **[M]**
- Microsoft no longer allows new multi-tenant Azure Bot registrations (deprecated after 31 July
  2025; single tenant and managed identity remain). So each customer tenant needs its own Azure
  Bot registration, created in that customer's tenant by its admin or by BE with delegated admin
  access. One service can still serve several tenants, holding one set of bot credentials per
  tenant. Version one serves BE's own tenant only; the schema and the Teams gateway are written
  for several from the start. **[C, pending Martin]**
- A **person** is a Microsoft user in that tenant, created on first contact (first message, first
  admin sign-in). Role: `user`, `head` (of one or more departments) or `admin`. **[M]**
- A **department** has a name, members, and heads. **[M]**
- Who gets a personal bot is a flag on the person, set by an admin or the person's head. **[M]**

### 4.2 Bot definitions

A bot definition is the unit an admin creates and edits. **[M]** Fields:

- Name, role label shown in chat, persona text (system prompt), Claude model.
- Microsoft identity: `person` (the bot acts as the person it talks to, personal bots only) or a
  `service account` the admin assigns (department bots). **[M]** A service account is connected by
  an admin signing it in once from the admin page (delegated sign-in, refresh token kept
  encrypted); application-wide Graph permissions are not used. If the tenant's MFA policy blocks
  the sign-in, the admin page says so and the admin excludes that account; that is the one Entra
  step we cannot remove. **[C]**
- Graph capabilities, each switchable: mail read, mail send, calendar read, calendar write, Teams
  chats and channels read, OneDrive and SharePoint files read, files write. **[M]**
- MCP servers: a list, each with name, transport (HTTP URL or command), credentials, and a test
  button. Added from the admin page, no code. **[M]**
- Connections: SSH hosts with keys, Windows hosts over SSH or WinRM, Proxmox API tokens, and new
  kinds over time. Each connection has a mode, `read-only` or `change`. **[M]** Enforcement **[C]**:
  a `read-only` connection's credential must itself be read-only on the target (a read-only
  account, a Proxmox token with an audit role); the admin page says so when the connection is
  created, and that credential is placed in the computer so the shell can use it freely. A
  `change` connection's credential is never placed in the computer; it is used only by a
  connection tool in the service process, and every call to that tool is gated by confirmation.
  So the shell can look anywhere it has been given read access and can change nothing on its own.
- Computer: on or off. A computer is a Linux container with the bot's read-only connection
  credentials placed as files or environment and no host mounts. **[M]** One container per bot
  definition for service-account bots, and one per person for bots whose identity is `person`, so
  no two people's sessions share a computer. **[C]**
- Web search and fetch: on or off.
- Departments allowed to use it. **[M]**
- Routines (section 4.6).
- Personas are set by admins and heads; users cannot change them. **[M]**

Built-in definitions a tenant starts with: `Personal` (identity `person`, all Graph capabilities,
computer on) and an empty template. **[C]**

### 4.3 Bots in Teams

- One Teams app, one Azure Bot registration, one bot identity "BE Bot" (brand name to be chosen by
  Martin). The admin **assigns** bot definitions to chats: a group chat can hold several roles,
  each person's one-to-one chat holds their personal bot. **[M, option 2]**
- Replies in a shared chat carry the role label at the top. **[M]**
- When several roles share a chat, the message names the role, or a cheap first model pass picks the
  role from the content. Each role keeps its own session and memory in that chat. **[C]**
- Roles can hand work to one another; when they do, the chat sees it as messages. **[M]**
- Unmentioned messages: the bot receives them (Teams resource-specific consent for chat read) and
  may chime in when its persona says to; by default it stays quiet unless mentioned, reminded, or
  running a routine. **[C]**
- When unsure, the bot asks the whole chat. In a one-to-one chat that is the person. **[M]**
- Later option: one Azure Bot registration per role so each role has its own name and avatar. The
  rest of the design does not change. **[C]**

### 4.4 Personal bot

- Acts as the person via Teams single sign-on: the service obtains a delegated Microsoft Graph token
  for the person and uses it for mail, calendar, chats and files. The person sees only what they
  can already see. **[M]**
- Admin consent for the Graph scopes happens once per tenant at install. **[M]**
- May send mail, book meetings and save files after the person confirms in the chat. **[M]**
- Stores nothing from mail or files beyond the conversation transcript, and transcripts are
  pruned after the tenant's retention period (default 30 days). The audit trail records targets,
  recipients, subjects, file names and a short summary of what was sent or written, never full
  bodies. **[C]**

### 4.5 Engine and computer

- Every (chat, role) pair maps to one Agent SDK session, resumed across messages. **[C]**
- Tools given to the session: Graph tools (our own small MCP server backed by the person's or
  service account's token), the definition's MCP servers, web search and fetch, and the computer's
  shell and file tools which run inside the bot's container. **[C]**
- The model never sees secrets: SSH keys and tokens are placed in the container; the Graph MCP
  server holds the delegated token in the service process. **[C]**
- Confirmation: any tool call that changes something (mail send, calendar write, file write,
  `change`-mode connections, MCP tools marked as writing) is gated: the bot posts what it is about
  to do and waits for a yes in the chat. Read-only tools run without asking. **[M]** The gate is a
  permission hook on the engine, one place. **[C]** The yes is a button on a card tied to that one
  pending action, so Teams tells us who clicked. For a personal bot only that person may confirm.
  For a department bot the person who asked, or a head or admin of a department allowed to use the
  bot, may confirm. A free-text "yes" is not a confirmation. **[C]**
- Model choice per definition. Default Haiku for light roles, a larger Claude model for roles that
  hold connections. **[C]**

### 4.6 Routines, reminders, checks

- A routine is a prompt plus a schedule plus a target chat, on a bot definition: "every morning at
  seven, check cluster health and last night's backups, post a summary; ask if something looks off".
  The engine runs it headless; the result is posted proactively to the target chat. **[M]**
- A check is a routine that posts only when its prompt reports a problem. **[C]**
- A reminder is a one-off routine a bot creates for itself from a conversation ("remind the room on
  Friday"). **[M]**
- Routines run with the definition's connections in `read-only` mode unless an admin grants
  `change` for that routine. With that grant the routine may make changes unattended, at any hour,
  with no person present: the admin's grant is the authority and the audit record names it. The
  routine still posts what it did to its target chat. Without the grant, anything needing
  confirmation waits in the chat like any other action. **[M]**

### 4.7 Audit trail

- Every action is a record: tenant, chat, person who asked, bot definition, what the bot did (each
  tool, Graph, connection and MCP call with its target and arguments, and what was sent or written),
  the confirmation that allowed it, timestamps, model, tokens and cost. **[M]**
- Written before the action runs and completed after, so a crash still leaves a trace. **[C]**
- Shown in the admin page as Activity, filterable by bot, person and chat, with export. Retention
  is a tenant setting. **[M]**

### 4.8 Admin web page

Behind Entra sign-in, admins and heads only (heads see their departments). Screens, and nothing
else: **[C]**

- **Bots**: list, create, edit a definition (4.2), with MCP, Connections, Routines as tabs.
- **People**: roster from the tenant, role, departments, personal-bot flag. Heads manage their own
  departments' members. **[M]**
- **Assignments**: which definitions live in which chats; chats appear once the app is in them.
- **Activity**: the audit trail.
- **Settings**: brand name, retention, default model, Anthropic spend cap.

Minimal copy. No explainer text.

## 5. Architecture

One Node service, one Postgres, N bot containers, on one host. **[C]**

```
Teams ──▶ Azure Bot ──▶ https://<host>/api/messages
                               │
                       Teams gateway (Microsoft 365 Agents SDK)
                               │  activity ──▶ (tenant, chat, role) ──▶ session
                               ▼
                       Engine runner (Claude Agent SDK, one query per message/routine)
                         ├── Graph MCP server (delegated or service token)
                         ├── definition's MCP servers
                         ├── permission hook: confirm-in-chat for writes, audit write
                         └── computer: exec in the bot's container (Docker API)
                               │
                       Postgres: tenants, people, departments, definitions, assignments,
                                 sessions, routines, audit, secrets (encrypted)
                       Scheduler: routines → engine runner → proactive message
                       Admin web: Entra sign-in, the five screens
```

Modules, each its own folder, no shared "utils" bag: `teams` (gateway, proactive send, SSO),
`engine` (SDK calls, hooks, session map), `graph` (Graph MCP server), `computer` (container per
definition, exec, secret placement), `org` (tenants, people, departments, assignments), `routines`
(scheduler), `audit`, `admin` (web), `db` (schema, migrations). **[C]**

Deployment: `docker compose up` with the service, Postgres and a Docker socket for bot containers.
Migrations run at start. One `.env` with the Anthropic key, Microsoft app credentials and the
secrets key. **[C]**

## 6. What the spike showed (2026-10-29, throwaway, `~/work/be-bot-spike` on the dev VM)

- Agent SDK with Haiku: shell tool, correct answer, 13.7 s, $0.0024, first call.
- Teams round trip through an Azure Bot (single tenant, F0) and a Tailscale Funnel to the dev VM:
  live message in a Teams chat answered in one turn, 7.6 s, $0.0005. Session resume across
  messages works. Unauthenticated posts to the endpoint are refused (401) by the Agents SDK.
- Teams setup: one Azure Bot resource, one app registration with a client secret, Teams channel on,
  a manifest zip uploaded as a custom app. About ten minutes of portal work by an admin.
- Not exercised: Teams single sign-on and delegated Graph, the container computer in a live chat,
  proactive messages, unmentioned-message reading. These carry the most unknowns and go first in
  the plan.

## 7. Security

- Delegated Graph tokens and service-account tokens live only in the service process and the
  database (encrypted); the model never sees them.
- Connection secrets are placed in the bot's container, never in the model's context or the audit
  trail; the audit trail records the command, not the key.
- Bot containers: no host mounts, unprivileged user, CPU, memory and pid limits, network reach only
  what the tenant's connections need (BE's own stack: the container joins the tailnet) **[C]**.
- The endpoint validates Bot Framework tokens; the admin page validates Entra tokens and tenant
  membership on every request.
- Writes require a confirmation in the chat from a person in that chat; routines inherit the
  grants an admin gave them.
- Prompt injection from mail, files and web pages is expected: the confirm-before-write gate and
  read-only defaults are the defence, not prompt wording.

## 8. Left to the builder

- Exact Graph scopes and the Teams SSO flow in the Agents SDK.
- Role picking when several roles share a chat (named prefix first, model pass second).
- Session storage: the SDK's own session files versus our own transcript table.
- How a container "joins the tailnet" (Tailscale sidecar, auth key per tenant).
- Admin web stack. **[C]**: server-rendered, minimal, no SPA, reuse nothing from BE Botter 1.
- Scheduler: Postgres-backed table polled by the service, no external queue.
- Migration safety: add first, drop later, as in BE Botter 1.

## 9. Open questions for Martin

1. Version one serves BE's tenant only, written for several (section 4.1): confirm.
2. Teams channels inside teams, not only group chats and one-to-one chats: in scope for version
   one? Section 4.3 is written for chats only until answered.
3. Brand name of the bot as it appears in Teams ("BE Bot" is the placeholder).
4. Which Claude model for roles with infrastructure connections (cost versus care).

Answered: routines with a `change` grant act unattended (Martin, 2026-10-29). Tracker project:
"BEBotter2" under Binary Elements.
