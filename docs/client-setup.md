# Setting BE Teammate up for another client

One instance per client tenant. Everything below is done in the client's own Entra tenant and Azure
subscription; nothing is shared with Binary Elements' instance except the code and the Docker image.

Work through it in this order — each step feeds the next.

## 0. What you need first

- The client's **Entra tenant id** and a Global Administrator (or Application Administrator + Privileged
  Role Administrator) to consent.
- An **Azure subscription** in that tenant, for the Azure Bot resource.
- A **host** with Docker/Coolify and a **public https URL** for the app (`PUBLIC_URL`), plus a Postgres.
- Optional: a **BE AgentMail** domain if the bots should have mailboxes.

## 1. Entra: one app registration for the bot

App registrations → **New registration** → name it after the bot (`<client> teammate`), **Single tenant**.

Note the **Application (client) ID** and **Directory (tenant) ID**. Create a **client secret** and copy the
**Value** (not the Secret ID) — it goes in two places below and is shown only once.

**Authentication → Add platform → Web**
- `<PUBLIC_URL>/admin/auth/callback` (the admin site's sign-in)
- `https://token.botframework.com/.auth/web/redirect` (Bot Framework token service; needed for Teams SSO)

**API permissions → Microsoft Graph**
- *Application*: `User.Read.All` (people sync), then **Grant admin consent**.
- *Delegated*: `openid profile email offline_access User.Read Mail.Read Mail.ReadWrite Mail.Send
  Calendars.ReadWrite Files.ReadWrite Files.ReadWrite.All Chat.Read Chat.ReadWrite` — consent as admin.

**Expose an API** (Teams SSO)
- Application ID URI: `api://botid-<client ID>`.
  - If the tenant refuses it (“All newly added URIs must contain a tenant verified domain, tenant ID or app
    ID”), set **Manifest → `accessTokenAcceptedVersion: 2`** and retry, or use `api://<client ID>` and put
    the same value in the Teams manifest's `webApplicationInfo.resource`.
- Add scope `access_as_user` (Admins and users, enabled).
- Add client applications `1fec8e78-bce4-4aaf-ab1b-5451cc387264` (Teams desktop/mobile) and
  `5e3ce6c0-2b1f-4285-8d4b-75ee78787346` (Teams web), each with `access_as_user` ticked. Without these,
  Teams will not hand the bot a token silently.

This is a *different* app from any admin-console OIDC app. Using the wrong one gives
`Failed to sign in (-120510)` with no detail; the app must be the one whose id is on the Azure Bot.

## 2. Azure Bot

Create an **Azure Bot** (resource group of your choice), **Single tenant**, using the app above.

- **Configuration → Microsoft App ID**: the client id; **App Tenant ID**: the tenant id.
- **Messaging endpoint**: `<PUBLIC_URL>/api/messages`.
- **Channels → Microsoft Teams**: enabled.
- **Configuration → OAuth Connection Settings → Add**:
  - Name: **`graph`** (the app reads `GRAPH_OAUTH_CONNECTION`, default `graph`)
  - Service Provider: **Azure Active Directory v2**
  - Client id / secret: the app above
  - Tenant ID: the tenant
  - **Token Exchange URL: `https://token.botframework.com/.auth/web/redirect`** (not the api:// URI)
  - Scopes: the delegated list from step 1
  - **Apply** — the connection is not saved until the blade's Apply is pressed.

The same thing over ARM, if you prefer:

```http
PUT https://management.azure.com/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.BotService/botServices/<bot>/connections/graph?api-version=2022-09-15
{
  "location": "global",
  "properties": {
    "clientId": "<client id>",
    "clientSecret": "<secret value>",
    "scopes": "User.Read Mail.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Files.ReadWrite Files.ReadWrite.All Chat.Read Chat.ReadWrite offline_access",
    "serviceProviderId": "30dd229c-58e3-4a48-bdfd-91ec48ebef30",
    "serviceProviderDisplayName": "Azure Active Directory v2",
    "parameters": [
      { "key": "tenantID", "value": "<tenant id>" },
      { "key": "tokenExchangeUrl", "value": "https://token.botframework.com/.auth/web/redirect" }
    ]
  }
}
```

## 3. Teams package

`teams-app/manifest.json` is the template. Replace, in `id`, `bots[0].botId` and `webApplicationInfo`:
the client's app id; and in `webApplicationInfo.resource`: the Application ID URI from step 1. Rename
`name.short` for the client, bump `version`, zip `manifest.json` + `color.png` + `outline.png`, and upload
in the **client's** Teams admin centre → Manage apps → Upload file, then publish to the org.

Resource-specific permissions (`ChatMessage.Read.Chat`, `ChannelMessage.Read.Group`) are what let a bot
hear every message in a group chat or channel rather than only @mentions; whoever installs the app
consents to them at install time.

## 4. Deploy the service

Coolify (or any Docker host) from `binaryelements/BEBotter2`, branch `deploy/coolify-prod` for a
client, image built from the repo `Dockerfile` (the heavy runtime is the published base image
`ghcr.io/binaryelements/bebotter2-base:1` — see `DEPLOY.md`).

Environment (see `.env.example`): `PUBLIC_URL`, `BOT_NAME`, `DATABASE_URL`, `SECRETS_KEY` (32 bytes,
base64 — encrypts every stored secret; losing it loses every connection and mailbox), `DEFAULT_MODEL`,
`DEEPSEEK_API_KEY` (or another provider), `clientId` / `clientSecret` / `tenantId` of the Entra app,
`ADMIN_EMAILS`, and optionally `AGENTMAIL_URL` + `AGENTMAIL_ADMIN_KEY`.

Migrations run at start; `/health` answers `{"ok":true}`.

## 5. First run

1. Open `<PUBLIC_URL>/admin` and sign in with an address in `ADMIN_EMAILS`.
2. **People** → *sync from Microsoft 365*: only licensed members are listed.
3. **Bots** → create the company bots (templates: IT support, finance, HR, general), one persona each.
4. Install the Teams app, message the bot, then **Bots → the bot → Chats** (or Assignments) to give each
   chat its bot. A chat with no bot is silent; naming a company bot in an unassigned chat assigns it.
5. **Personal assistants**: on **People**, switch *My assistant* on for whoever should have one, then name
   it and set its owner on the assistant's page. Owners talk to it in their own 1:1 chat; naming it in any
   other chat runs the task and answers privately.
6. **Runbooks / playbooks**: upload each procedure on **Runbooks** and give it to one bot — a note belongs
   to that bot alone; shared notes are visible to all.
7. Optional: mailboxes per bot (BE AgentMail), and each bot's **Inbound webhook** URL for outside systems.

## 6. Verify

- `POST <PUBLIC_URL>/api/messages` from Teams: say “hi” in the 1:1 — a reply with the bot's name in bold.
- My assistant: send anything in the 1:1; a **sign-in card** appears once, and afterwards it acts as you.
  If it says “Sign-in didn't work”, the OAuth connection (step 2) or the Expose-an-API pieces (step 1) are
  incomplete — the app logs `sign-in failed …` with the SDK's inner exception chain.
- Inbound hook: `curl -X POST <PUBLIC_URL>/hooks/<bot>/<secret> -H 'content-type: application/json' -d '{"text":"test"}'`
  answers `202` and the notice appears in the bot's chats.
- People sync: the People list shows exactly the licensed members.

## 7. Things that bite

- The client secret expires (24 months max). Rotate it in Entra **and** in the OAuth connection **and** in
  the app's environment in the same sitting, or sign-in and the people sync break together.
- `api://botid-<id>` is rejected by tenants with the default identifier-URI policy unless the app issues
  v2 tokens; see step 1.
- The Teams package and the app registration must name the same audience, or Teams refuses to issue the
  SSO token (`invalid_resource`).
- A bot posts into **every chat it is assigned to**; mail notices and webhooks follow the same list.
- `SECRETS_KEY` must never change after the first connection is saved.
