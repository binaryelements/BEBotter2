import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { CanUseTool, HookCallback, Options, query } from "@anthropic-ai/claude-agent-sdk";
import { beginAction, completeAction, recordAuthority, summarise } from "../audit/audit.js";
import { mcpServerConfigs } from "../bots/definitions.js";
import { ensureComputer } from "../computer/computer.js";
import type { DockerClient } from "../computer/docker.js";
import { computerMcpServer } from "../computer/mcp.js";
import type { Db } from "../db/client.js";
import { sessions } from "../db/schema.js";
import type { BotDefinition, Person } from "../db/schema.js";
import type { Confirmations } from "./confirm.js";
import { classify } from "./gate.js";

export type RunnerDeps = { db: Db; queryFn: typeof query; confirmations: Confirmations; secretsKey: Buffer; docker: DockerClient; computerImage: string };
export type ConfirmationRequest = { actionId: string; label: string; summary: string; args: string };
export type RunResult = { text: string; costUsd: number; sessionId: string };

const MAX_AUDIT_INPUT = 2000;
const MAX_CARD_ARGS = 4000;
const FAILED_TEXT = "I couldn't finish that.";

export type RunTurnInput = {
  tenantId: string;
  chatId: string;
  definition: BotDefinition;
  person: Person;
  text: string;
  askConfirmation: (req: ConfirmationRequest) => Promise<void>;
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

  // tool use id → audit row of a call that was allowed and has not finished yet
  const inFlight = new Map<string, string>();

  const canUseTool: CanUseTool = async (toolName, input, { toolUseID }) => {
    const json = JSON.stringify(input);
    const auditId = await beginAction(db, {
      ...base,
      kind: "tool",
      toolName,
      toolInput: json.length <= MAX_AUDIT_INPUT ? input : { truncated: true, preview: json.slice(0, MAX_AUDIT_INPUT) },
      summary: summarise(toolName, input),
    });
    if (classify(toolName, definition) === "read") {
      inFlight.set(toolUseID, auditId);
      return { behavior: "allow", updatedInput: input };
    }
    // the card shows every argument, so a call too large to show is never asked
    const args = JSON.stringify(input, null, 2);
    if (args.length > MAX_CARD_ARGS) {
      await completeAction(db, auditId, { status: "denied" });
      return { behavior: "deny", message: "Not done: the request was too large to show for confirmation." };
    }
    const { actionId, outcome } = deps.confirmations.create({ auditId, askerPersonId: person.id });
    let o: "confirmed" | "denied" | "expired" | "failed";
    try {
      await turn.askConfirmation({ actionId, label: definition.label, summary: summarise(toolName, input), args });
      o = await outcome;
    } catch {
      o = "failed"; // the question never reached the asker; the model gets the denial and the turn goes on
    }
    if (o === "confirmed") {
      await recordAuthority(db, auditId, { type: "confirmation", personId: person.id });
      inFlight.set(toolUseID, auditId);
      return { behavior: "allow", updatedInput: input };
    }
    await completeAction(db, auditId, { status: o });
    return { behavior: "deny", message: "Not confirmed." };
  };

  const afterTool: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse" && input.hook_event_name !== "PostToolUseFailure") return {};
    const auditId = inFlight.get(input.tool_use_id);
    if (auditId) {
      inFlight.delete(input.tool_use_id);
      await completeAction(db, auditId, { status: input.hook_event_name === "PostToolUse" ? "done" : "failed" });
    }
    return {};
  };

  const cwd = path.join(os.tmpdir(), "bebotter2", chatId);
  mkdirSync(cwd, { recursive: true });
  const options: Options = {
    model: definition.model,
    systemPrompt: definition.persona,
    cwd,
    tools: definition.webSearch ? ["WebSearch", "WebFetch"] : [],
    allowedTools: [], // a tool named here bypasses canUseTool
    permissionMode: "default",
    settingSources: [],
    persistSession: true,
    maxTurns: 25,
    ...(session ? { resume: session.sdkSessionId } : {}),
    mcpServers: { ...(computer ? { computer } : {}), ...mcpServerConfigs(definition, deps.secretsKey) },
    canUseTool,
    hooks: { PostToolUse: [{ hooks: [afterTool] }], PostToolUseFailure: [{ hooks: [afterTool] }] },
  };

  const auditMessage = async (summary: string, status: "done" | "failed", costUsd?: number) => {
    const auditId = await beginAction(db, { ...base, kind: "message", summary: summary.slice(0, 200), model: definition.model });
    await completeAction(db, auditId, { status, ...(costUsd !== undefined ? { costUsd } : {}) });
  };

  try {
    for await (const msg of deps.queryFn({ prompt: turn.text, options })) {
      if (msg.type !== "result") continue;
      // a "success" with is_error carries API error text in result, which must not reach the chat
      const ok = msg.subtype === "success" && !msg.is_error;
      const text = ok && msg.subtype === "success" ? msg.result : FAILED_TEXT;
      const now = new Date();
      await db
        .insert(sessions)
        .values({ chatId, definitionId: definition.id, sdkSessionId: msg.session_id, updatedAt: now })
        .onConflictDoUpdate({ target: [sessions.chatId, sessions.definitionId], set: { sdkSessionId: msg.session_id, updatedAt: now } });
      await auditMessage(text, ok ? "done" : "failed", msg.total_cost_usd);
      return { text, costUsd: msg.total_cost_usd, sessionId: msg.session_id };
    }
    await auditMessage(FAILED_TEXT, "failed");
    throw new Error("Agent SDK query ended without a result");
  } finally {
    // allowed but never finished (interrupted, maxTurns hit, stream died)
    for (const auditId of inFlight.values()) await completeAction(db, auditId, { status: "failed" });
    inFlight.clear();
  }
}
