// Publishes the Teams app package and installs it in chats through Microsoft Graph, as the bot's own Entra app.
// Needs the app to hold AppCatalog.ReadWrite.All and TeamsAppInstallation.ReadWriteAndConsentForChat.All.
// usage (inside the app container, where clientId/clientSecret/tenantId are set):
//   node scripts/teams-catalog.mjs status
//   node scripts/teams-catalog.mjs publish <package.zip>
//   node scripts/teams-catalog.mjs install <chatId>     installs or upgrades the app in a group chat and consents to reading its messages
import { readFile } from "node:fs/promises";

const { tenantId, clientId, clientSecret } = process.env;
const [cmd, arg] = process.argv.slice(2);
if (!tenantId || !clientId || !clientSecret) throw new Error("tenantId, clientId and clientSecret must be set");

const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
  method: "POST",
  body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, scope: "https://graph.microsoft.com/.default" }),
});
const { access_token: token, error_description } = await tokenRes.json();
if (!token) throw new Error(`token: ${error_description ?? tokenRes.status}`);

async function graph(path, init = {}) {
  const r = await fetch(`https://graph.microsoft.com/v1.0${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${r.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}
const json = (body) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function app() {
  const { value } = await graph(`/appCatalogs/teamsApps?$filter=externalId eq '${clientId}'&$expand=appDefinitions($select=id,version,publishingState)`);
  return value[0];
}

if (cmd === "status") {
  const a = await app();
  if (!a) { console.log("not in the catalogue"); process.exit(0); }
  console.log(`${a.displayName} ${a.id}`);
  for (const d of a.appDefinitions) console.log(`  ${d.version} ${d.publishingState}`);
} else if (cmd === "publish") {
  const a = await app();
  const body = await readFile(arg);
  const path = a ? `/appCatalogs/teamsApps/${a.id}/appDefinitions?requiresReview=false` : `/appCatalogs/teamsApps?requiresReview=false`;
  const d = await graph(path, { method: "POST", headers: { "Content-Type": "application/zip" }, body });
  console.log(a ? `published ${d.version} ${d.publishingState}` : `created ${d.id}`);
} else if (cmd === "install") {
  const a = await app();
  if (!a) throw new Error("publish the app first");
  const consent = { consentedPermissionSet: { resourceSpecificPermissions: [{ permissionValue: "ChatMessage.Read.Chat", permissionType: "Application" }] } };
  const chat = `/chats/${encodeURIComponent(arg)}/installedApps`;
  const { value } = await graph(`${chat}?$expand=teamsApp&$filter=teamsApp/id eq '${a.id}'`);
  if (value[0]) {
    await graph(`${chat}/${value[0].id}/upgrade`, { method: "POST", ...json(consent) });
    console.log("upgraded with consent");
  } else {
    await graph(chat, { method: "POST", ...json({ "teamsApp@odata.bind": `https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/${a.id}`, ...consent }) });
    console.log("installed with consent");
  }
} else {
  console.log("usage: status | publish <zip> | install <chatId>");
  process.exit(1);
}
