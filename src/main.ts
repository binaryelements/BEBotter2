import { startServer } from "@microsoft/agents-hosting-express";
import { realOidcDeps } from "./admin/oidc.js";
import { adminRouter } from "./admin/router.js";
import { startAuditPruning } from "./audit/audit.js";
import { dockerodeClient } from "./computer/docker.js";
import { loadConfig } from "./config/config.js";
import { loadEnvFile } from "./config/env-file.js";
import { documentReader } from "./engine/read-document.js";
import { deepseekBalance } from "./engine/balances.js";
import { startAlertScheduler } from "./alerts/alert.js";
import { graphFetchUsers, startPeopleSync } from "./org/directory-sync.js";
import { backfillBotModels, backfillPersonalAssistants } from "./bots/definitions.js";
import { getTenantSettings, setTenantSettings } from "./org/org.js";
import { connect } from "./db/client.js";
import { tenants } from "./db/schema.js";
import { Confirmations } from "./engine/confirm.js";
import { McpPool } from "./engine/mcp-pool.js";
import { OpenAICompatEngine } from "./engine/openai.js";
import { modelSlugs } from "./engine/providers.js";
import { systemSsh } from "./connections/ssh.js";
import { agentMailAdmin } from "./mail/agentmail.js";
import { mountMailInbound } from "./mail/inbound.js";
import { ensureAllMailboxes, ensureMailbox } from "./mail/mailboxes.js";
import { runTurn } from "./engine/runner.js";
import type { RunnerDeps } from "./engine/runner.js";
import { startReflectionScheduler } from "./reflections/scheduler.js";
import { startScheduler } from "./routines/scheduler.js";
import { createTeamsApp, graphToken } from "./teams/app.js";
import { personToken, sendToChat } from "./teams/proactive.js";

loadEnvFile();
const config = loadConfig(process.env);
const db = await connect(config.databaseUrl);
for (const t of await db.select({ id: tenants.id }).from(tenants)) {
  await backfillBotModels(db, t.id, config.defaultModel).catch((e) => console.error(`bot models for tenant ${t.id}:`, e instanceof Error ? e.message : "error"));
  await backfillPersonalAssistants(db, t.id, config.defaultModel).catch((e) => console.error(`personal assistants for tenant ${t.id}:`, e instanceof Error ? e.message : "error"));
  const settings = await getTenantSettings(db, t.id).catch(() => undefined);
  if (settings && !settings.alertEmails && config.adminEmails.length) await setTenantSettings(db, t.id, { ...settings, alertEmails: config.adminEmails.join(",") }).catch((e) => console.error(`alert recipients for tenant ${t.id}:`, e instanceof Error ? e.message : "error"));
}
const confirmations = new Confirmations();
const engine = new OpenAICompatEngine({ providers: config.providers });
// only models whose provider has a key, so the runbook review never offers a model that cannot answer
const models = modelSlugs().filter((slug) => !!config.providers[slug.slice(0, slug.indexOf("/"))]?.apiKey);
// stdio MCP clients (the browser, the files server) stay warm between turns; the browser is keyed per chat
const mcpPool = new McpPool({ idleMs: 10 * 60_000, max: 20 });
const runnerDeps: RunnerDeps = {
  db,
  engine,
  confirmations,
  secretsKey: config.secretsKey,
  docker: dockerodeClient(config.dockerSocket),
  computerImage: config.computerImage,
  filesDir: config.filesDir,
  ssh: systemSsh(),
  publicUrl: config.publicUrl,
  agentmailUrl: config.agentmail?.url,
  fetchFn: fetch,
  readDocument: documentReader(),
  mcpPool,
  // called only during turns, long after `proactive` and `app` below exist
  personToken: (chatId) => personToken(proactive, chatId, (ctx) => graphToken(app, ctx)),
};
const mail = config.agentmail
  ? { db, secretsKey: config.secretsKey, admin: agentMailAdmin(config.agentmail, fetch), publicUrl: config.publicUrl }
  : undefined;
const balance = config.providers.deepseek?.apiKey ? deepseekBalance(config.providers.deepseek.apiKey) : undefined;
const fetchUsers = graphFetchUsers(config);
const turn = (t: Parameters<typeof runTurn>[1]) => runTurn(runnerDeps, t);
const app = createTeamsApp({ db, runTurn: turn, confirmations, botName: config.botName, defaultModel: config.defaultModel, graphConnection: config.graphOAuthConnection });

const proactive = { db, adapter: app.adapter, botAppId: config.teams.clientId };

// The Agents SDK reads clientId, tenantId and clientSecret from the environment.
startServer(app, {
  port: config.port,
  beforeListen: (express) => {
    mountMailInbound(express, { db, secretsKey: config.secretsKey, send: (chatId, m) => sendToChat(proactive, chatId, m) });
    // a refused Teams delivery (auth, rate limit, handler error) is otherwise invisible
    express.use("/api/messages", (req, res, next) => {
      res.on("finish", () => {
        if (res.statusCode >= 300) console.warn(`/api/messages answered ${res.statusCode} (${(req.body as { type?: string } | undefined)?.type ?? "?"})`);
      });
      next();
    });
    express.use("/admin", adminRouter({ ...realOidcDeps(config, db), botName: config.botName, defaultModel: config.defaultModel, models, engine, fetchUsers, mail, runTurn: turn, confirmations, ...(balance ? { balance } : {}),
      // never fails or delays the save; a missed attempt is retried on the next save or start
      onBotSaved: mail && ((id) => void ensureMailbox(mail, id).catch((e) => console.error("mailbox:", e instanceof Error ? e.name : "error"))),
    }));
    express.get("/health", (_req, res) => void res.json({ ok: true }));
    express.get("/", (_req, res) => res.redirect(302, "/admin"));
  },
});

if (mail) void ensureAllMailboxes(mail);
startAuditPruning(db, 24 * 60 * 60 * 1000);
startPeopleSync(db, config.teams.tenantId, fetchUsers, 24 * 60 * 60 * 1000);
startScheduler({ db, runTurn: turn, send: (chatId, m) => sendToChat(proactive, chatId, m), personToken: (chatId) => personToken(proactive, chatId, (ctx) => graphToken(app, ctx)) });
startReflectionScheduler({ db, engine, send: (chatId, text) => sendToChat(proactive, chatId, text) });
if (mail) startAlertScheduler({ db, admin: mail.admin, ...(balance ? { balance } : {}) });

for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => void mcpPool.close().finally(() => process.exit(0)));
