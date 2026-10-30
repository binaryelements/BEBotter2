import { mkdirSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import type { CanUseTool, HookCallback, McpServerConfig, Options, SDKResultMessage, query } from "@anthropic-ai/claude-agent-sdk";
import { confirmerPolicy } from "../admin/access.js";
import { beginAction, completeAction, recordAuthority, summarise } from "../audit/audit.js";
import { mcpServerConfigs } from "../bots/definitions.js";
import { ensureComputer } from "../computer/computer.js";
import type { DockerClient } from "../computer/docker.js";
import { computerMcpServer } from "../computer/mcp.js";
import { connectionsMcpServer } from "../connections/mcp.js";
import type { SshRunner } from "../connections/ssh.js";
import { connectionMcpConfigs } from "../connections/store.js";
import { knowledgeMcpServer } from "../knowledge/mcp.js";
import { routineMcpServer } from "../routines/mcp.js";
import type { Db } from "../db/client.js";
import { sessions } from "../db/schema.js";
import type { BotDefinition, Person } from "../db/schema.js";
import type { Confirmations, Outcome } from "./confirm.js";
import { classify } from "./gate.js";

export type RunnerDeps = {
  db: Db;
  queryFn: typeof query;
  confirmations: Confirmations;
  secretsKey: Buffer;
  docker: DockerClient;
  computerImage: string;
  filesDir: string;
  ssh: SshRunner;
  /** Base URL of this service, for the one-time secret links. */
  publicUrl: string;
  /** For http connections and verifying mcp connections. */
  fetchFn: typeof fetch;
  /** Built-in MCP servers (knowledge, connections, routine); `confirmedBy` names who confirmed the call now running. */
  builtinServers?: (ctx: { confirmedBy: () => string | undefined }) => Record<string, McpServerConfig>;
};
export type ConfirmationRequest = { actionId: string; label: string; summary: string; args: string };
/** changed: a write completed under a routine grant, so the run must say what it did. */
export type RunResult = { text: string; costUsd: number; sessionId: string; changed: boolean };

const TRANSIENT = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET"]);
const MAX_AUDIT_INPUT = 2000;
const MAX_CARD_ARGS = 4000;
const FAILED_TEXT = "I couldn't finish that.";
const NOT_DONE = {
  denied: "Not done: declined in the chat.",
  expired: "Not done: nobody confirmed within 10 minutes. Tell the chat you did not do it.",
  failed: "Not done: the confirmation could not be sent.",
};

export type RunTurnInput = {
  tenantId: string;
  chatId: string;
  definition: BotDefinition;
  person: Person;
  text: string;
  askConfirmation: (req: ConfirmationRequest) => Promise<void>;
  /** A scheduled run. With a grantPersonId an admin has let it make changes unattended. */
  routine?: { id: string; grantPersonId: string | null; post: (text: string) => Promise<void> };
};

export async function runTurn(deps: RunnerDeps, turn: RunTurnInput): Promise<RunResult> {
  const { db } = deps;
  const { tenantId, chatId, definition, person } = turn;
  const base = { tenantId, chatId, definitionId: definition.id, personId: person.id };

  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.chatId, chatId), eq(sessions.definitionId, definition.id)));
  const computer = definition.computer
    ? computerMcpServer(deps.docker, await ensureComputer(db, deps.docker, deps.computerImage, definition.id))
    : undefined;
  const conn = await connectionMcpConfigs(db, deps.secretsKey, tenantId, definition.id);

  // tool use id → audit row of a call that was allowed and has not finished yet
  const inFlight = new Map<string, string>();
  const granted = new Set<string>(); // tool use ids allowed by a routine grant
  let changed = false;
  // SDK tool handlers never see the confirmation. Parallel calls may be confirmed in any order, so only an
  // approve-class call sets the marker and approve calls run one at a time, each waiting for the previous to finish.
  let lastConfirmer: string | undefined;
  const confirmedBy = () => lastConfirmer;
  let approveTail: Promise<void> = Promise.resolve();
  const approveReleases = new Map<string, () => void>(); // tool use id → frees the next approve call
  const releaseApprove = (toolUseID: string) => {
    const release = approveReleases.get(toolUseID);
    if (!release) return;
    approveReleases.delete(toolUseID);
    lastConfirmer = undefined;
    release();
  };

  const canUseTool: CanUseTool = async (toolName, input, { toolUseID }) => {
    const json = JSON.stringify(input);
    const auditId = await beginAction(db, {
      ...base,
      kind: "tool",
      toolName,
      toolInput: json.length <= MAX_AUDIT_INPUT ? input : { truncated: true, preview: json.slice(0, MAX_AUDIT_INPUT) },
      summary: summarise(toolName, input),
    });
    const kind = classify(toolName, definition, conn.readOnly);
    if (kind === "read") {
      inFlight.set(toolUseID, auditId);
      return { behavior: "allow", updatedInput: input };
    }
    const grant = turn.routine?.grantPersonId;
    if (kind === "write" && grant) {
      await recordAuthority(db, auditId, { type: "grant", personId: grant, routineId: turn.routine!.id });
      inFlight.set(toolUseID, auditId);
      granted.add(toolUseID);
      return { behavior: "allow", updatedInput: input };
    }
    if (kind === "approve") {
      const previous = approveTail;
      approveTail = new Promise<void>((resolve) => approveReleases.set(toolUseID, resolve));
      await previous;
    }
    // the card shows every argument, so a call too large to show is never asked
    const args = JSON.stringify(input, null, 2);
    if (args.length > MAX_CARD_ARGS) {
      await completeAction(db, auditId, { status: "denied" });
      releaseApprove(toolUseID);
      return { behavior: "deny", message: "Not done: the request was too large to show for confirmation." };
    }
    const { actionId, outcome } = deps.confirmations.create({ auditId, mayConfirm: confirmerPolicy(db, tenantId, definition.id, person.id, kind) });
    let o: Outcome | { result: "failed" };
    try {
      await turn.askConfirmation({ actionId, label: definition.label, summary: summarise(toolName, input), args });
      o = await outcome;
    } catch (err) {
      console.error("confirmation card failed", err);
      o = { result: "failed" }; // the question never reached the asker; the model gets the denial and the turn goes on
    }
    if (o.result === "confirmed") {
      if (kind === "approve") lastConfirmer = o.personId;
      await recordAuthority(db, auditId, { type: "confirmation", personId: o.personId });
      inFlight.set(toolUseID, auditId);
      return { behavior: "allow", updatedInput: input };
    }
    await completeAction(db, auditId, { status: o.result });
    releaseApprove(toolUseID);
    return { behavior: "deny", message: NOT_DONE[o.result] };
  };

  const afterTool: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse" && input.hook_event_name !== "PostToolUseFailure") return {};
    const auditId = inFlight.get(input.tool_use_id);
    if (auditId) {
      inFlight.delete(input.tool_use_id);
      releaseApprove(input.tool_use_id);
      await completeAction(db, auditId, { status: input.hook_event_name === "PostToolUse" ? "done" : "failed" });
      if (input.hook_event_name === "PostToolUse" && granted.has(input.tool_use_id)) changed = true;
    }
    return {};
  };

  // the SDK advertises cwd to MCP servers as the client root, so it must be the folder the files server serves
  mkdirSync(deps.filesDir, { recursive: true });
  const options: Options = {
    model: definition.model,
    systemPrompt: definition.persona,
    cwd: deps.filesDir,
    tools: definition.webSearch ? ["WebSearch", "WebFetch"] : [],
    allowedTools: [], // a tool named here bypasses canUseTool
    permissionMode: "default",
    settingSources: [],
    persistSession: true,
    maxTurns: 25,
    // the model's process gets no service secrets, only what it needs to run
    env: Object.fromEntries(["PATH", "HOME", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"].filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
    mcpServers: { ...(computer ? { computer } : {}), knowledge: knowledgeMcpServer(deps, base), connections: connectionsMcpServer(deps, { ...base, confirmedBy }), routine: routineMcpServer(deps, { ...base, post: turn.routine?.post }), ...deps.builtinServers?.({ confirmedBy }), ...mcpServerConfigs(definition, deps.secretsKey), ...conn.servers },
    canUseTool,
    hooks: { PostToolUse: [{ hooks: [afterTool] }], PostToolUseFailure: [{ hooks: [afterTool] }] },
  };

  const auditMessage = async (summary: string, status: "done" | "failed", costUsd?: number) => {
    const auditId = await beginAction(db, { ...base, kind: "message", summary: summary.slice(0, 200), model: definition.model });
    await completeAction(db, auditId, { status, ...(costUsd !== undefined ? { costUsd } : {}) });
  };

  const once = async (resume?: string): Promise<SDKResultMessage | undefined> => {
    for await (const msg of deps.queryFn({ prompt: turn.text, options: { ...options, ...(resume ? { resume } : {}) } })) {
      if (msg.type === "result") return msg;
    }
    return undefined;
  };
  // one transient-network retry per turn, so with the resume retry a turn runs at most three attempts
  let networkRetried = false;
  const attempt = async (resume?: string): Promise<SDKResultMessage | undefined> => {
    try {
      return await once(resume);
    } catch (err) {
      const e = err as { code?: string; message?: string; cause?: { code?: string } };
      const code = e.cause?.code ?? e.code;
      if (networkRetried || !((code && TRANSIENT.has(code)) || e.message === "fetch failed")) throw err;
      networkRetried = true;
      console.warn("engine call failed, retrying once", code);
      return once(resume);
    }
  };
  // a "success" with is_error carries API error text in result, which must not reach the chat
  const succeeded = (msg?: SDKResultMessage) => msg?.subtype === "success" && !msg.is_error;

  try {
    let msg: SDKResultMessage | undefined;
    if (session) {
      try {
        msg = await attempt(session.sdkSessionId);
      } catch (err) {
        console.error("resume failed", err);
      }
      if (!succeeded(msg)) {
        // the transcript may be gone (redeploy, lost volume); start a fresh session once
        if (msg) await auditMessage(FAILED_TEXT, "failed", msg.total_cost_usd);
        await db.delete(sessions).where(and(eq(sessions.chatId, chatId), eq(sessions.definitionId, definition.id)));
        msg = await attempt();
      }
    } else {
      msg = await attempt();
    }
    if (!msg) {
      await auditMessage(FAILED_TEXT, "failed");
      throw new Error("Agent SDK query ended without a result");
    }
    const ok = succeeded(msg);
    const text = ok && msg.subtype === "success" ? msg.result : FAILED_TEXT;
    const now = new Date();
    await db
      .insert(sessions)
      .values({ chatId, definitionId: definition.id, sdkSessionId: msg.session_id, updatedAt: now })
      .onConflictDoUpdate({ target: [sessions.chatId, sessions.definitionId], set: { sdkSessionId: msg.session_id, updatedAt: now } });
    await auditMessage(text, ok ? "done" : "failed", msg.total_cost_usd);
    return { text, costUsd: msg.total_cost_usd, sessionId: msg.session_id, changed };
  } finally {
    // allowed but never finished (interrupted, maxTurns hit, stream died)
    for (const auditId of inFlight.values()) await completeAction(db, auditId, { status: "failed" });
    inFlight.clear();
    for (const id of [...approveReleases.keys()]) releaseApprove(id);
  }
}
