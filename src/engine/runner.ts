import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { CanUseTool, HookCallback, Options, query } from "@anthropic-ai/claude-agent-sdk";
import { beginAction, completeAction, summarise } from "../audit/audit.js";
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
export type ConfirmationRequest = { actionId: string; label: string; summary: string };
export type RunResult = { text: string; costUsd: number; sessionId: string };

const MAX_AUDIT_INPUT = 2000;

export async function runTurn(
  deps: RunnerDeps,
  turn: {
    tenantId: string;
    chatId: string;
    definition: BotDefinition;
    person: Person;
    text: string;
    askConfirmation: (req: ConfirmationRequest) => Promise<void>;
  },
): Promise<RunResult> {
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

  // canUseTool gets no tool_use_id, so the PostToolUse hook finds its audit row by name + input.
  // shortcut: two identical calls in one turn share a key; key on tool_use_id if the SDK starts passing it.
  const inFlight = new Map<string, { auditId: string; authority?: { type: "confirmation"; personId: string } }>();
  const keyOf = (toolName: string, input: unknown) => toolName + JSON.stringify(input);

  const canUseTool: CanUseTool = async (toolName, input) => {
    const json = JSON.stringify(input);
    const auditId = await beginAction(db, {
      ...base,
      kind: "tool",
      toolName,
      toolInput: json.length <= MAX_AUDIT_INPUT ? input : { truncated: true, preview: json.slice(0, MAX_AUDIT_INPUT) },
      summary: summarise(toolName, input),
    });
    if (classify(toolName, definition) === "read") {
      inFlight.set(keyOf(toolName, input), { auditId });
      return { behavior: "allow", updatedInput: input };
    }
    const { actionId, outcome } = deps.confirmations.create({ auditId, askerPersonId: person.id });
    await turn.askConfirmation({ actionId, label: definition.label, summary: summarise(toolName, input) });
    const o = await outcome;
    if (o === "confirmed") {
      inFlight.set(keyOf(toolName, input), { auditId, authority: { type: "confirmation", personId: person.id } });
      return { behavior: "allow", updatedInput: input };
    }
    await completeAction(db, auditId, { status: o });
    return { behavior: "deny", message: "Not confirmed." };
  };

  const postToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse") return {};
    const key = keyOf(input.tool_name, input.tool_input);
    const entry = inFlight.get(key);
    if (entry) {
      inFlight.delete(key);
      await completeAction(db, entry.auditId, { status: "done", ...(entry.authority ? { authority: entry.authority } : {}) });
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
    hooks: { PostToolUse: [{ hooks: [postToolUse] }] },
  };

  for await (const msg of deps.queryFn({ prompt: turn.text, options })) {
    if (msg.type !== "result") continue;
    const ok = msg.subtype === "success";
    const text = ok ? msg.result : "I couldn't finish that.";
    const now = new Date();
    await db
      .insert(sessions)
      .values({ chatId, definitionId: definition.id, sdkSessionId: msg.session_id, updatedAt: now })
      .onConflictDoUpdate({ target: [sessions.chatId, sessions.definitionId], set: { sdkSessionId: msg.session_id, updatedAt: now } });
    const auditId = await beginAction(db, { ...base, kind: "message", summary: text.slice(0, 200), model: definition.model });
    await completeAction(db, auditId, { status: ok ? "done" : "failed", costUsd: msg.total_cost_usd });
    return { text, costUsd: msg.total_cost_usd, sessionId: msg.session_id };
  }
  throw new Error("Agent SDK query ended without a result");
}
