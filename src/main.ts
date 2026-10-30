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
import { runTurn } from "./engine/runner.js";
import type { RunnerDeps } from "./engine/runner.js";
import { createTeamsApp } from "./teams/app.js";

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
};
const fetchUsers = graphFetchUsers(config);
const app = createTeamsApp({ db, runTurn: (turn) => runTurn(runnerDeps, turn), confirmations, botName: config.botName });

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
