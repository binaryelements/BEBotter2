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
import { systemSsh } from "./connections/ssh.js";
import { runTurn } from "./engine/runner.js";
import type { RunnerDeps } from "./engine/runner.js";
import { startScheduler } from "./routines/scheduler.js";
import { createTeamsApp } from "./teams/app.js";
import { sendToChat } from "./teams/proactive.js";

loadEnvFile();
const config = loadConfig(process.env);
const db = await connect(config.databaseUrl);
const confirmations = new Confirmations();
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
  fetchFn: fetch,
};
const fetchUsers = graphFetchUsers(config);
const turn = (t: Parameters<typeof runTurn>[1]) => runTurn(runnerDeps, t);
const app = createTeamsApp({ db, runTurn: turn, confirmations, botName: config.botName });

// The Agents SDK reads clientId, tenantId and clientSecret from the environment; the agent SDK reads ANTHROPIC_API_KEY.
startServer(app, {
  port: config.port,
  beforeListen: (express) => {
    express.use("/admin", adminRouter({ ...realOidcDeps(config, db), botName: config.botName, defaultModel: config.defaultModel, fetchUsers }));
    express.get("/health", (_req, res) => void res.json({ ok: true }));
  },
});

startAuditPruning(db, 24 * 60 * 60 * 1000);
startPeopleSync(db, config.teams.tenantId, fetchUsers, 24 * 60 * 60 * 1000);
const proactive = { db, adapter: app.adapter, botAppId: config.teams.clientId };
startScheduler({ db, runTurn: turn, send: (chatId, m) => sendToChat(proactive, chatId, m) });
