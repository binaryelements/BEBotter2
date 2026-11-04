# BE Teammate: handover

State as of 2 November 2026. BE Teammate (earlier "BE Branded Bot", then "BE Team Botter"; the repo keeps the name BEBotter2) is Binary Elements' bots in Microsoft Teams: one Teams app, many bots, built on the Claude Agent SDK. Teams is the only front end; the admin site is at `/admin`.

The design is `docs/superpowers/specs/2026-10-29-be-botter-2-design.md`; each feature has a plan in `docs/superpowers/plans/`. This page says what exists, where it runs, how to change it, and what is still open.

## What it does

- **One Teams identity, many bots.** A tenant has bot definitions (persona, model, tools, connections, mailbox). A chat is assigned one definition; every reply starts with the bot's name in bold.
- **Company bots** (identity `service`), e.g. IT Support "Iris", Marketing Specialist. Who may use one follows its departments; no departments means everyone.
- **My assistant** (identity `person`), one built-in definition per tenant. It acts as the person in Microsoft 365 (mail, calendar, files, Teams chats) with their own delegated sign-in, only in that person's one-to-one chat, only for people whose "My assistant" switch is on (People screen).
- **Choosing a bot.** A one-to-one chat with two or more usable bots shows "Who would you like to talk to?"; `switch` shows it again. With one usable bot it answers directly.
- **Confirmation.** Writes ask in the chat with a card; per-bot action rules can free a tool or force approval. Microsoft 365 writes (send, reply, book, respond, upload) always ask and cannot be freed. Only the person who asked confirms; for My assistant, only its owner.
- **Connections.** Bots request SSH, HTTP and MCP connections themselves; secrets come in through one-time links; admins see and revoke them on the Connections screen. My assistant gets none.
- **Shared notes, routines, reminders, checks.** Per tenant; routines may act unattended only with an admin grant (never for Microsoft 365 writes).
- **Bot mailboxes.** Optional per bot, on BE AgentMail; the admin types the address's local part (blank means no email) and can remove it.
- **Computers.** A bot with `computer: true` gets a sandbox container on the host's Docker. Not offered for My assistant (it would need one per person).
- **Audit.** Every turn and tool call is recorded with timings and cost; Microsoft 365 rows keep targets and subjects, never bodies.
- **Admin site.** Microsoft sign-in, roles admin/head/user. Screens: Overview, Bots (tabbed bot page), Assignments, Shared notes, Connections, People, Departments, Activity, Settings. BE design system, dark/light, phone layout.

## Where it runs

| | Production | Staging |
|---|---|---|
| URL | https://botter.binaryelements.com | https://botter-staging.binaryelements.com |
| Coolify app | `xuh7byogsimqmjbfrw1j21tc` | `kpshtybky8uau7n156shieru` |
| Branch | `master` | `master` (set to a feature branch while one is tested) |
| Postgres container | `lisy6lvpdv231gqtfletgn3n` | `rtwqv8uosze2wv1jt5prou36` |
| Entra app (client ID) | `e68b650a-fd8e-4086-b717-517d2631cc6f` | `ffdddfc8-106f-409b-8c26-82832ede9487` |
| Azure Bot (resource group `base`) | `be-bot-spike` | `be-team-botter-staging` |
| Teams app | "BE Teammate" (same id as the Entra app) | "BE Teammate (staging)" |

- Coolify is at cool.growth-elements.com; both apps run on the host reachable as `be-botter` over SSH. Deploy: Coolify API `POST /api/v1/deploy?uuid=<app>`; change branch with `PATCH /api/v1/applications/<app>` `{git_branch}`.
- Logs: `docker logs <container>` on the host (`chat …`, `turn … ready= first= deliver= tools=` lines per turn).
- The Azure Bot messaging endpoint is `<URL>/api/messages`. Bot icon URL: `https://botter.binaryelements.com/admin/assets/be/be-mark-cyan.png`.
- Secrets live in each Coolify app's environment (see `.env.example` for the names). Never commit them.

## Microsoft 365 sign-in for My assistant

Done on staging, **not yet on production**. Without it, choosing My assistant on production answers "Sign-in didn't work".

On the Entra app:
1. Expose an API: Application ID URI `api://botid-<client ID>`; scope `access_as_user` (admins and users); authorised clients `1fec8e78-bce4-4aaf-ab1b-5451cc387264` and `5e3ce6c0-2b1f-4285-8d4b-75ee78787346`.
2. Authentication: Web redirect URI `https://token.botframework.com/.auth/web/redirect` (next to the admin callback `<URL>/admin/auth/callback`).
3. API permissions, Microsoft Graph delegated: `User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Files.ReadWrite.All Chat.Read offline_access openid profile`, then grant admin consent. (People sync separately needs application `User.Read.All`.)
4. A client secret for the connection below.

On the Azure Bot, Configuration, OAuth connection named exactly `graph` (`GRAPH_OAUTH_CONNECTION` overrides the name): Azure Active Directory v2, the client ID and secret, token exchange URL `api://botid-<client ID>`, the tenant ID, the scopes above.

The Teams package must carry `webApplicationInfo` with the same client ID and resource (version 1.1.0 does; the staging package swaps the id).

## Teams packages

`teams-app/manifest.json` is the production manifest (version 1.2.0; 1.2.0 adds the resource-specific permissions `ChatMessage.Read.Chat` and `ChannelMessage.Read.Group`, so the bot hears every message in group chats and channels, not only @mentions; whoever adds the app to a chat consents to it there). The staging package is the same with the staging client ID in `id`, `bots[0].botId` and `webApplicationInfo`, and "(staging)" in the name. Zip `manifest.json`, `color.png` and `outline.png`, and upload in Teams admin centre, Manage apps, the app, Upload file. Bump `version` on every change.

## Working on the code

- Node 24, TypeScript ESM, pnpm, Express, Drizzle/Postgres, `@microsoft/agents-hosting` 1.9.1, Claude Agent SDK. Tests: vitest with PGlite, offline (Graph, Teams and the model are faked).
- The dev VM is often heavily loaded: run test files one at a time (`npx vitest run <file>`), never two test processes at once; `src/teams/handlers.test.ts` alone takes several minutes. `npx tsc --noEmit` for types.
- Migrations are additive only (old and new release run side by side for a few seconds).
- Copy is minimal and lowercase on buttons; every new visible line is quoted in its PR.
- Main places: `src/teams/` (Teams app, handlers, cards, streaming), `src/engine/` (runner, warm engines, confirmation gate), `src/graph/` (My assistant's Microsoft 365 tools), `src/connections/`, `src/knowledge/`, `src/admin/`, `src/db/schema.ts`.

## History (merged PRs)

- #6 admin UI on the BE design system (theme icons, phone menu).
- #7 bot name on every reply; action rules told to the model.
- #8 own sign-in page (a Safe Browsing "deceptive" flag on the bare Microsoft redirect) and `/` redirects to `/admin`.
- #9 Connections screen and clearer per-bot connections.
- #10 renamed to BE Teammate.
- #11 personal bots: My assistant, the choose card, Microsoft 365 sign-in and tools, admin switch; whole-branch review fixes keep it private (no shared-note writes, connections, departments or computer).

Before these: core service, admin page, connections/knowledge/routines, bot mailboxes, responsiveness (warm engines, streaming, timings), and the cut-over from the dev VM to Coolify production (2026-11-01).

## In progress

Branch `feature/read-attachment` (deployed to staging, PR to open after trying it):
- `read_mail` lists attachments; `read_attachment` reads text, images, and PDFs (a separate tool-less model run transcribes the PDF, since a tool result can't hand the model a PDF).
- Streamed replies no longer stick half-written with a Stop button: Teams refused the final message because it didn't carry on from what was streamed. The bot's name now streams first and the final message keeps everything streamed.

## Open items

1. **Production database backups: none yet.** Turn on Coolify scheduled backups for both Postgres containers (decide on off-site storage).
2. Production Microsoft 365 sign-in setup (above), then upload the 1.1.0 package and switch My assistant on for people.
3. Group chat memory: the listening half is built (`src/teams/overheard.ts`, 3 Nov 2026). In a group chat the bot answers only when @mentioned or addressed by name ("Mickey, …"); everything else is kept in `chat_messages` and handed to its next turn there, then pruned with the audit retention. Admins switch listening off per chat on Assignments. Still from spec 4.12: daily/monthly summaries for admins, and the "stop listening" opt-out in personal chats.
4. Addressing a bot by name per message (spec 4.13, next step).
5. A separate Teams identity per bot (wanted later).
6. Computers: decide whether they move to a separate VM, and whether the admin site shows the bot's screen.
7. A container HEALTHCHECK for the app.
8. My assistant: `switch` typed while a sign-in card waits counts as a sign-in attempt (the SDK has no supported way to cancel a pending sign-in); OneDrive PDFs are not read yet (attachments are); uploads are limited by the confirmation card size and never overwrite.
9. Leftover "sshtest" connection on production: revoke it on the Connections screen.
