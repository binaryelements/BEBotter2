import { query } from "@anthropic-ai/claude-agent-sdk";
import { startServer } from "@microsoft/agents-hosting-express";
import { realOidcDeps } from "./admin/oidc.js";
import { adminRouter } from "./admin/router.js";
import { startAuditPruning } from "./audit/audit.js";
import { dockerodeClient } from "./computer/docker.js";
import { loadConfig } from "./config/config.js";
import { loadEnvFile } from "./config/env-file.js";
import { graphFetchUsers, startPeopleSync } from "./org/directory-sync.js";
import { connect } from "./db/client.js";
import { Confirmations } from "./engine/confirm.js";
import { LiveSessions } from "./engine/live.js";
import { systemSsh } from "./connections/ssh.js";
import { agentMailAdmin } from "./mail/agentmail.js";
import { mountMailInbound } from "./mail/inbound.js";
import { ensureAllMailboxes, ensureMailbox } from "./mail/mailboxes.js";
import { prewarmRecent, runTurn } from "./engine/runner.js";
import type { RunnerDeps } from "./engine/runner.js";
import { startScheduler } from "./routines/scheduler.js";
import { createTeamsApp } from "./teams/app.js";
import { sendToChat } from "./teams/proactive.js";

loadEnvFile();
const config = loadConfig(process.env);
const db = await connect(config.databaseUrl);
const confirmations = new Confirmations();
// operational limits: an idle chat's engine stops after 60 minutes, and at most 20 stay warm
// engines stay up until `max` evicts the least recently used (~310 MB each); restarts re-warm chats used in the last day
const warm = { idleMs: Infinity, max: 20, recentMs: 24 * 60 * 60_000 };
const live = new LiveSessions(query, warm);
const runnerDeps: RunnerDeps = {
  db,
  queryFn: query,
  confirmations,
  secretsKey: config.secretsKey,
  docker: dockerodeClient(config.dockerSocket),
  computerImage: config.computerImage,
  filesDir: config.filesDir,
  ssh: systemSsh(),
  publicUrl: config.publicUrl,
  agentmailUrl: config.agentmail?.url,
  fetchFn: fetch,
  live,
};
const mail = config.agentmail
  ? { db, secretsKey: config.secretsKey, admin: agentMailAdmin(config.agentmail, fetch), publicUrl: config.publicUrl }
  : undefined;
const fetchUsers = graphFetchUsers(config);
const turn = (t: Parameters<typeof runTurn>[1]) => runTurn(runnerDeps, t);
const app = createTeamsApp({ db, runTurn: turn, confirmations, botName: config.botName });

const proactive = { db, adapter: app.adapter, botAppId: config.teams.clientId };

// The Agents SDK reads clientId, tenantId and clientSecret from the environment; the agent SDK reads ANTHROPIC_API_KEY.
startServer(app, {
  port: config.port,
  beforeListen: (express) => {
    mountMailInbound(express, { db, secretsKey: config.secretsKey, send: (chatId, m) => sendToChat(proactive, chatId, m) });
    express.use("/admin", adminRouter({ ...realOidcDeps(config, db), botName: config.botName, defaultModel: config.defaultModel, fetchUsers, mail,
      // never fails or delays the save; a missed attempt is retried on the next save or start
      onBotSaved: mail && ((id) => void ensureMailbox(mail, id).catch((e) => console.error("mailbox:", e instanceof Error ? e.name : "error"))),
    }));
    express.get("/health", (_req, res) => void res.json({ ok: true }));
  },
});

if (mail) void ensureAllMailboxes(mail);
// chats used within the idle window would still be warm had the service not restarted
void prewarmRecent(runnerDeps, { withinMs: warm.recentMs, max: warm.max });
startAuditPruning(db, 24 * 60 * 60 * 1000);
startPeopleSync(db, config.teams.tenantId, fetchUsers, 24 * 60 * 60 * 1000);
startScheduler({ db, runTurn: turn, send: (chatId, m) => sendToChat(proactive, chatId, m) });

for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => void live.closeAll().finally(() => process.exit(0)));
