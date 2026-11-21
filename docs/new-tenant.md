# Installing BE Teammate for another Microsoft 365 tenant

One running copy of BE Teammate serves one Microsoft 365 tenant. Its `clientId`, `tenantId` and
`clientSecret` pin the Teams bot sign-in, the admin sign-in (`src/admin/oidc.ts` refuses any other
tenant), the people sync and every Graph call. A new customer therefore gets **its own Entra app, its own
Azure Bot, its own Coolify app and its own database**. Nothing is shared with other customers, and no code
changes are needed. The steps for our own tenant are in [handover.md](handover.md); this is the same setup
for a customer.

Allow about half a day, most of it waiting on the customer's admin for consent.

## 1. Collect before you start

| What | From whom | Example |
| --- | --- | --- |
| Tenant ID (Directory ID) | Customer's Entra admin centre, Overview | `11111111-…` |
| An admin who can register apps and grant admin consent (Global Admin or Privileged Role Admin) | Customer | |
| Who administers BE Teammate (emails) | Customer | `it@customer.com` |
| Public URL | Us | `https://customer.teammate.binaryelements.com` |
| Model provider key (DeepSeek or Qwen) | Us, a separate key per customer, so cost is visible per key | |
| Bot name shown in Teams | Customer | `Customer Teammate` |

Keep these in the BE Feature Tracker request for the customer, never in the repo. Secrets go only into
Coolify's environment and the Azure Bot.

## 2. Entra app, in the customer's tenant

Done by the customer's admin, or by us with a guest admin account they give us.

1. **App registrations, New registration.** Name `BE Teammate`. Supported account types: *this
   organizational directory only*. Note the **Application (client) ID**.
2. **Authentication, Web redirect URIs:**
   - `<PUBLIC_URL>/admin/auth/callback` (admin sign-in)
   - `https://token.botframework.com/.auth/web/redirect` (My assistant sign-in)
3. **Certificates & secrets:** a client secret, 24 months. Record its expiry date in the tracker request;
   the value goes into Coolify and the Azure Bot only.
4. **Expose an API:** Application ID URI `api://botid-<client ID>`. Add scope `access_as_user` (admins and
   users). Authorised client applications (the Teams clients):
   `1fec8e78-bce4-4aaf-ab1b-5451cc387264` and `5e3ce6c0-2b1f-4285-8d4b-75ee78787346`.
5. **API permissions, Microsoft Graph:**
   - Application: `User.Read.All` (people sync).
   - Delegated, for My assistant: `User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite
     Files.ReadWrite.All Chat.Read offline_access openid profile`.
   - Optional, application, only if we publish and install the Teams app through Graph (step 6b):
     `AppCatalog.ReadWrite.All` and `TeamsAppInstallation.ReadWriteAndConsentForChat.All`.
   - Then **Grant admin consent for the customer**.

Skip the delegated permissions if the customer will not use My assistant; everything else still works.

## 3. Azure Bot, in our Azure subscription

1. Create an **Azure Bot** in resource group `base`, named `be-teammate-<customer>`. Pricing F0 (free)
   until message volume needs S1.
2. Type of app: **Single Tenant**. App ID = the client ID from step 2; app tenant ID = the customer's
   tenant ID.
3. **Configuration:** messaging endpoint `<PUBLIC_URL>/api/messages`.
4. **Channels:** add Microsoft Teams.
5. **Configuration, OAuth connection settings** (only for My assistant): name exactly `graph`
   (`GRAPH_OAUTH_CONNECTION` overrides it). Service provider *Azure Active Directory v2*, the client ID and
   secret, tenant ID = the customer's, token exchange URL `api://botid-<client ID>`, scopes as in step 2.5.
   **Test connection** should sign in as a customer account.

Not yet tried: an Azure Bot in our subscription whose app lives in the customer's tenant. If Azure refuses
the customer's app ID in step 3.2, create the Azure Bot in a subscription in the customer's tenant instead;
everything else stays the same.

## 4. Coolify app and database

1. A new **Postgres 17** database in Coolify, `teammate-<customer>-db`. Turn on scheduled backups.
2. A new **application** from repo `binaryelements/BEBotter2`, branch `deploy/coolify-prod`, built from
   the `Dockerfile`. Domain = the public URL, port 3978.
3. **Volumes**, as in `compose.yaml`: `/var/run/docker.sock:/var/run/docker.sock` (the computer
   sandbox) and a persistent volume on `/srv/files`.
4. The sandbox image `bebotter2-computer` is built once per host and already exists on `be-botter`. On a
   new host: `docker build -f computer.Dockerfile -t bebotter2-computer .`.
5. **Environment** (names from `.env.example`):

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | the new database's internal URL |
| `SECRETS_KEY` | new, `openssl rand -base64 32`; never reuse another install's key |
| `PUBLIC_URL` | `https://customer.teammate.binaryelements.com`, no trailing slash |
| `ADMIN_EMAILS` | the customer's admin emails |
| `BOT_NAME` | the customer's bot name |
| `clientId` / `tenantId` / `clientSecret` | from step 2; `tenantId` is the customer's |
| `DEEPSEEK_API_KEY` or `DASHSCOPE_API_KEY` | the customer's provider key |
| `DEFAULT_MODEL` | `deepseek/deepseek-flash` or `qwen/qwen3.8-flash` |
| `AGENTMAIL_ADMIN_KEY` | only if the customer gets bot mailboxes; unset otherwise |
| `BE_HUB_API_KEY`, `MANTIS_MCP_SECRET` | leave unset: these connect our own systems |

6. Deploy. Migrations run on start. `<PUBLIC_URL>/health` returns `{"ok":true}`.

## 5. Teams package

`teams-app/` carries our production bot ID. Make a copy for the customer and do not commit it:

1. Copy `teams-app/` to a scratch folder. In `manifest.json`, put the customer's client ID in `id`,
   `bots[0].botId`, `webApplicationInfo.id` and `webApplicationInfo.resource` (`api://botid-<client ID>`).
   Change `name.short` and `name.full` if the customer wants their own name.
2. Zip `manifest.json`, `color.png` and `outline.png`, with the files at the top level of the zip.

## 6. Install in the customer's Teams

Either:

- **a. By their admin:** Teams admin centre, Teams apps, Manage apps, *Upload new app*, the zip. If custom
  apps are blocked, allow this one in their app permission policy.
- **b. Through Graph** (needs the optional permissions in step 2.5): copy the zip and
  `scripts/teams-catalog.mjs` into the customer's app container, run
  `node teams-catalog.mjs publish <zip>`, then `node teams-catalog.mjs status` to check.

For a later manifest version: bump `version`, publish again, and run
`node teams-catalog.mjs install <chatId>` for each group chat so its read-messages consent upgrades.

## 7. First run

1. An admin from `ADMIN_EMAILS` signs in at `<PUBLIC_URL>/admin`.
2. **Settings:** the company time zone, location and country.
3. **People:** press sync. The customer's licensed users appear (needs the `User.Read.All` consent).
4. **Bots:** create the first bot, or load the example in the container:
   `pnpm bot-def upsert --tenant <tenantId> --file examples/it-support.json`.
5. In Teams, add the app to a chat and message it, then assign the bot to that chat on Assignments.

## 8. Smoke checks

- [ ] `/health` returns ok and the first logs show no errors.
- [ ] A 1:1 message gets a text answer.
- [ ] In a group chat the bot answers, and hears messages without an @mention.
- [ ] A write tool shows the approval card; approving it gives a `done` row on Activity.
- [ ] My assistant signs in and reads the person's mail (only if enabled).
- [ ] Activity shows a cost per turn.

## Keeping it up to date

- Every Coolify app on `deploy/coolify-prod` redeploys on each push to that branch. To control when a
  customer upgrades, point their app at a release branch and move it when ready.
- **Client secret expiry:** keep the date in the tracker and renew a month before. An expired secret stops
  the bot answering in Teams.
- Keep the list of customer installs (Coolify app ID, Azure Bot name, tenant ID, secret expiry) in the
  servers memory or the tracker, not in this repo.

## Removing a customer

Take a final backup if the customer wants their data, then delete the Coolify app and its database and the
Azure Bot. Ask the customer to delete the Entra app, which removes every consent.
