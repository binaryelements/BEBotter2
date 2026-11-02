import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { and, desc, eq, gt } from "drizzle-orm";
import type { CanUseTool, HookCallback, McpServerConfig, Options, SDKMessage, SDKResultMessage, query } from "@anthropic-ai/claude-agent-sdk";
import { confirmerPolicy } from "../admin/access.js";
import { auditInput, beginAction, completeAction, recordAuthority, summarise } from "../audit/audit.js";
import { definitionsForChat, mcpServerConfigs } from "../bots/definitions.js";
import { ensureComputer } from "../computer/computer.js";
import type { DockerClient } from "../computer/docker.js";
import { computerMcpServer } from "../computer/mcp.js";
import { connectionsMcpServer } from "../connections/mcp.js";
import type { SshRunner } from "../connections/ssh.js";
import { connectionMcpConfigs } from "../connections/store.js";
import { m365McpServer } from "../graph/mcp.js";
import { knowledgeMcpServer } from "../knowledge/mcp.js";
import { routineMcpServer } from "../routines/mcp.js";
import type { Db } from "../db/client.js";
import { chats, mailboxes, sessions } from "../db/schema.js";
import { getTenantSettings } from "../org/org.js";
import type { TenantSettings } from "../org/org.js";
import { decrypt } from "../secrets/cipher.js";
import type { BotDefinition, Person, TurnTimings } from "../db/schema.js";

export type { TurnTimings };
import type { Confirmations, Outcome } from "./confirm.js";
import { classify } from "./gate.js";
import type { LiveSessions } from "./live.js";
import { recordTools, toolRule, toolRulesFor } from "./tool-rules.js";

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
  /** BE AgentMail base URL; without it bots get no `mail` server. */
  agentmailUrl?: string;
  /** For http connections and verifying mcp connections. */
  fetchFn: typeof fetch;
  /** A PDF's or Office file's text, for attachments the person's assistant opens; without it they give their details only. */
  readDocument?: (fileBase64: string, name: string) => Promise<string>;
  /** Built-in MCP servers (knowledge, connections, routine); `confirmedBy` names who confirmed the call now running. */
  builtinServers?: (ctx: { confirmedBy: () => string | undefined }) => Record<string, McpServerConfig>;
  /** Warm engine processes per chat and bot; without it every turn starts its own. */
  live?: LiveSessions;
};
/** name: the bot's display name, when it has one; input: the call's arguments as the model sent them. */
export type ConfirmationRequest = { actionId: string; label: string; name?: string; toolName: string; input: Record<string, unknown> };
/** changed: a write completed under a routine grant, so the run must say what it did. */
export type RunResult = { text: string; costUsd: number; sessionId: string; changed: boolean; timings: TurnTimings; /** the turn's message audit row */ auditId: string; /** Graph refused the person's token: sign them out so the next message brings the sign-in card */ signInLost?: boolean };
/** delta: reply text as the model writes it; message-end: an assistant message finished. */
export type ProgressEvent = { kind: "text"; text: string } | { kind: "tool"; toolName: string } | { kind: "delta"; text: string } | { kind: "message-end" };

const TRANSIENT = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET"]);
const MAX_AUDIT_INPUT = 2000;
const MAX_CARD_ARGS = 4000;
const FAILED_TEXT = "I couldn't finish that.";
const NOT_DONE = {
  denied: "Not done: declined in the chat.",
  expired: "Not done: nobody confirmed within 10 minutes. Tell the chat you did not do it.",
  failed: "Not done: the confirmation could not be sent.",
};

/** What a turn's SDK options act for. A live process outlives its turns, so its options read the turn running now through this. */
type TurnScope = { personId: string; canUseTool: CanUseTool; afterTool: HookCallback; confirmedBy: () => string | undefined; post?: (text: string) => Promise<void>; graphToken?: () => Promise<string | undefined>; signInLost: () => void };
// live pool → key → the turn running on that key
const liveTurns = new WeakMap<LiveSessions, Map<string, TurnScope>>();
const turnsOn = (pool: LiveSessions) => liveTurns.get(pool) ?? liveTurns.set(pool, new Map()).get(pool)!;

type EngineSetup = Awaited<ReturnType<typeof engineSetup>>;

/** Everything a turn's engine options depend on, shared by turns and prewarm so a warmed process is the one a turn would start. */
async function engineSetup(deps: RunnerDeps, tenantId: string, chatId: string, definition: BotDefinition, routine: boolean) {
  const { db } = deps;
  const containerId = definition.computer ? await ensureComputer(db, deps.docker, deps.computerImage, definition.id) : undefined;
  const conn = await connectionMcpConfigs(db, deps.secretsKey, tenantId, definition.id);
  const [mailbox] = deps.agentmailUrl ? await db.select().from(mailboxes).where(eq(mailboxes.definitionId, definition.id)) : [];
  // the bot's own agent key goes to the SDK subprocess as a header, never to the model or the computer
  let mail: { address: string; keyId: string | null; key: string } | undefined;
  if (mailbox?.status === "active" && mailbox.keyCipher && mailbox.address) {
    try {
      mail = { address: mailbox.address, keyId: mailbox.keyId, key: decrypt(deps.secretsKey, mailbox.keyCipher) };
    } catch (e) {
      console.error("mailbox key:", e instanceof Error ? e.name : "error"); // no mail this turn; the turn still runs
    }
  }
  // the admin's per-action rules, so the bot does not tell people an action needs confirming when it runs freely
  const rules = [...(await toolRulesFor(db, definition.id))].sort(([a], [b]) => a.localeCompare(b));
  const ruleNote = (rule: string, words: string) => {
    const names = rules.filter(([, r]) => r === rule).map(([t]) => t.replace(/^mcp__.+?__/, ""));
    return names.length ? ` ${words}: ${names.join(", ")}.` : "";
  };
  const rulesText =
    ruleNote("free", "An admin set these actions to run without a confirmation card, so run them and never say they need confirming") +
    ruleNote("confirm", "An admin set these actions to need a confirmation card in the chat");
  // the SDK advertises cwd to MCP servers as the client root, so it must be the folder the files server serves
  mkdirSync(deps.filesDir, { recursive: true });
  // a process with no turn running (warmed, or between turns) acts for nobody
  const buildOptions = (current: () => TurnScope | undefined): Options => {
    const turn = () => {
      const t = current();
      if (!t) throw new Error("no turn is running on this live session");
      return t;
    };
    // getters, never copies: servers built here must act for the turn running when a tool is called, not the one that started the process
    const ctx = {
      tenantId,
      chatId,
      definitionId: definition.id,
      get personId() { return turn().personId; },
      // read when the servers are built too, so it is absent rather than an error with no turn; a chat process never posts
      get post() { return current()?.post; },
      confirmedBy: () => current()?.confirmedBy(),
      // asked on every Graph call, so a warm process uses the token of the turn running now; between turns there is none
      graphToken: async () => current()?.graphToken?.(),
      signInLost: () => current()?.signInLost(),
    };
    const afterTool: HookCallback = async (...a) => current()?.afterTool(...a) ?? {};
    const canUseTool: CanUseTool = async (toolName, input, o) => {
      const t = current();
      if (t) return t.canUseTool(toolName, input, o);
      const auditId = await beginAction(db, { tenantId, chatId, definitionId: definition.id, kind: "tool", toolName, summary: summarise(toolName, input) });
      await completeAction(db, auditId, { status: "failed" });
      return { behavior: "deny", message: "Not done: no message is being answered." };
    };
    return {
      model: definition.model,
      systemPrompt: `${definition.persona}\n\n${definition.displayName ? `Your name is ${definition.displayName}. ` : ""}${
        mail
          ? `Your own email address is ${mail.address}.`
          : `You have no email address and cannot send or receive email${deps.agentmailUrl ? "; an admin can add one on the admin page" : ""}.`
      }${DEFAULTS_NOTE}${rulesText}`,
      cwd: deps.filesDir,
      tools: definition.webSearch ? ["WebSearch", "WebFetch"] : [],
      allowedTools: [], // a tool named here bypasses canUseTool
      permissionMode: "default",
      settingSources: [],
      persistSession: true,
      includePartialMessages: true, // text as it is written, for streaming replies
      maxTurns: 25,
      // the model's process gets no service secrets, only what it needs to run
      env: Object.fromEntries(["PATH", "HOME", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"].filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
      mcpServers: {
        ...mcpServerConfigs(definition, deps.secretsKey),
        ...(containerId ? { computer: computerMcpServer(deps.docker, containerId) } : {}),
        // Personal reads shared notes but stores nothing and reaches no company systems: what it saw in one person's mail must not reach others
        knowledge: knowledgeMcpServer(deps, ctx, definition.identity === "person"),
        ...(definition.identity === "person" ? {} : { connections: connectionsMcpServer(deps, ctx) }),
        routine: routineMcpServer(deps, ctx),
        ...(definition.identity === "person" && definition.graph.length ? { m365: m365McpServer(deps, ctx, definition.graph) } : {}),
        ...(mail ? { mail: { type: "http" as const, url: `${deps.agentmailUrl}/mcp`, headers: { Authorization: `Bearer ${mail.key}` } } } : {}),
        ...deps.builtinServers?.({ confirmedBy: ctx.confirmedBy }),
        ...(definition.identity === "person" ? {} : conn.servers),
      },
      canUseTool,
      hooks: { PostToolUse: [{ hooks: [afterTool] }], PostToolUseFailure: [{ hooks: [afterTool] }] },
    };
  };
  // anything the options capture at start is in the fingerprint
  const fingerprint = createHash("sha256").update(JSON.stringify([definition.id, definition.updatedAt, definition.identity, definition.graph, containerId ?? null, conn, routine, rules, mail ? [mailbox!.status, mail.keyId, mail.address] : null])).digest("hex");
  return { conn, buildOptions, fingerprint };
}

/** A live process's options: they read whichever turn is running on its key, and resume the stored session. */
const liveOptions = (pool: LiveSessions, key: string, setup: EngineSetup, session?: { sdkSessionId: string }): Options => ({
  ...setup.buildOptions(() => turnsOn(pool).get(key)),
  ...(session ? { resume: session.sdkSessionId } : {}),
});

export type RunTurnInput = {
  tenantId: string;
  chatId: string;
  definition: BotDefinition;
  person: Person;
  text: string;
  askConfirmation: (req: ConfirmationRequest) => Promise<void>;
  /** A scheduled run. With a grantPersonId an admin has let it make changes unattended. */
  /** When the turn was asked for (the message arrived, the routine was due); defaults to now. */
  receivedAt?: Date;
  progress?: (event: ProgressEvent) => void;
  routine?: { id: string; grantPersonId: string | null; post: (text: string) => Promise<void> };
  /** The person's Microsoft Graph token, asked for per call; only for person definitions. Never stored, logged or shown to the model. */
  graphToken?: () => Promise<string | undefined>;
};

/**
 * The message as the model gets it: first a line with the time now in the company's time zone and its default place.
 * Read on every turn, so a changed setting counts from the next message, warm process or not.
 */
export function withDefaults(text: string, s: Pick<TenantSettings, "timezone" | "location" | "country">, at: Date): string {
  const now = new Intl.DateTimeFormat("en-AU", { timeZone: s.timezone, dateStyle: "full", timeStyle: "short" }).format(at);
  const place = [s.location, s.country].filter(Boolean).join(", ");
  return `[${DEFAULTS_TAG} now ${now} (${s.timezone})${place ? `; location ${place}` : ""}]\n\n${text}`;
}
const DEFAULTS_TAG = "defaults:";
const DEFAULTS_NOTE = ` Each message starts with a line in square brackets that begins "${DEFAULTS_TAG}". The system adds it, not the person: the time now, and the company's default time zone and location. Use them unless the person says otherwise in this chat, and then keep to what they said. Never mention the line itself.`;

export async function runTurn(deps: RunnerDeps, turn: RunTurnInput): Promise<RunResult> {
  const { db } = deps;
  const { tenantId, chatId, definition, person } = turn;
  const base = { tenantId, chatId, definitionId: definition.id, personId: person.id };
  const received = turn.receivedAt ?? new Date();
  const timings: TurnTimings = { receivedAt: received.toISOString(), tools: 0 };
  // phase bookkeeping for one SDK message; a live-session pool can feed its messages here too
  const report = (event: ProgressEvent) => {
    try {
      turn.progress?.(event);
    } catch (err) {
      console.error("progress callback failed", err); // a broken listener must not abort the SDK stream
    }
  };
  // each attempt starts over, so the timings describe the attempt that answered
  const resetTimings = () => {
    for (const k of ["engineReadyAt", "firstOutputAt", "firstToolAt", "resultAt", "live"] as const) delete timings[k];
    timings.tools = 0;
  };
  // the engine's own tool list, for the admin page; awaited before the turn ends, and its failure never fails the turn
  let toolsRecorded = Promise.resolve();
  const observe = (msg: SDKMessage) => {
    const at = new Date().toISOString();
    if (msg.type === "system" && msg.subtype === "init") {
      timings.engineReadyAt ??= at;
      const tools = msg.tools ?? []; // never trust the engine's message to be complete
      toolsRecorded = toolsRecorded.then(() => recordTools(db, definition.id, tools)).catch((e) => console.error("recording tools failed", e instanceof Error ? e.name : "unknown"));
    }
    if (msg.type === "result") timings.resultAt = at;
    // a subagent's words are not the reply
    if (msg.type === "stream_event" && msg.parent_tool_use_id === null) {
      const e = msg.event;
      if (e.type === "content_block_delta" && e.delta.type === "text_delta") report({ kind: "delta", text: e.delta.text });
      else if (e.type === "message_stop") report({ kind: "message-end" });
    }
    if (msg.type !== "assistant") return;
    for (const block of msg.message.content) {
      if (block.type === "text") {
        timings.firstOutputAt ??= at;
        report({ kind: "text", text: block.text });
      } else if (block.type === "tool_use") {
        timings.firstOutputAt ??= at;
        timings.firstToolAt ??= at;
        timings.tools++;
        report({ kind: "tool", toolName: block.name });
      }
    }
  };

  // a run under an admin grant starts clean: text from the chat must not steer it, and its context stays out of the chat's session
  const ownSession = !!turn.routine?.grantPersonId;
  const [session] = ownSession ? [] : await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.chatId, chatId), eq(sessions.definitionId, definition.id)));
  // the engine reports a session's running total, resumed sessions included; a turn's cost is the growth since the last one seen
  let lastCost = Number(session?.lastCostUsd ?? 0);
  const turnCost = (total: number) => (ownSession ? total : Math.round((total >= lastCost ? total - lastCost : total) * 1e6) / 1e6);
  const setup = await engineSetup(deps, tenantId, chatId, definition, !!turn.routine);
  const { conn } = setup;

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
  // Each attempt (live, retry, fallback) starts from clean bookkeeping. A call still pending from an attempt whose
  // process died must not hold up, or be authorised in, the next one.
  let attemptNo = 0;
  const settle = async () => {
    attemptNo++;
    for (const auditId of inFlight.values()) {
      try {
        await completeAction(db, auditId, { status: "failed" });
      } catch (err) {
        console.error("closing an unfinished action failed", err instanceof Error ? err.message : "unknown"); // never replaces the turn's answer
      }
    }
    inFlight.clear();
    for (const id of [...approveReleases.keys()]) releaseApprove(id);
    approveTail = Promise.resolve();
    lastConfirmer = undefined;
  };
  const STALE = { behavior: "deny" as const, message: "Not done: the attempt that asked has ended." };

  const canUseTool: CanUseTool = async (toolName, input, { toolUseID }) => {
    const run = attemptNo;
    const audited = auditInput(toolName, input);
    const json = JSON.stringify(audited);
    const auditId = await beginAction(db, {
      ...base,
      kind: "tool",
      toolName,
      toolInput: json.length <= MAX_AUDIT_INPUT ? audited : { truncated: true, preview: json.slice(0, MAX_AUDIT_INPUT) },
      summary: summarise(toolName, input),
    });
    const stale = async () => {
      await completeAction(db, auditId, { status: "failed" });
      return STALE;
    };
    // read per call, so an admin's change applies to the next call without restarting the engine
    const rule = await toolRule(db, definition.id, toolName);
    if (run !== attemptNo) return stale();
    const kind = classify(toolName, definition, conn.readOnly, rule);
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
      if (run !== attemptNo) return stale();
    }
    try {
      // the card shows every argument, so a call too large to show is never asked
      if (JSON.stringify(input, null, 2).length > MAX_CARD_ARGS) {
        await completeAction(db, auditId, { status: "denied" });
        releaseApprove(toolUseID);
        return { behavior: "deny", message: "Not done: the request was too large to show for confirmation." };
      }
      const { actionId, outcome } = deps.confirmations.create({ auditId, mayConfirm: confirmerPolicy(db, tenantId, definition.id, person.id, kind, chatId) });
      let o: Outcome | { result: "failed" };
      try {
        await turn.askConfirmation({ actionId, label: definition.label, ...(definition.displayName ? { name: definition.displayName } : {}), toolName, input });
        o = await outcome;
      } catch (err) {
        console.error("confirmation card failed", err);
        o = { result: "failed" }; // the question never reached the asker; the model gets the denial and the turn goes on
      }
      if (run !== attemptNo) return stale();
      if (o.result === "confirmed") {
        if (kind === "approve") lastConfirmer = o.personId;
        await recordAuthority(db, auditId, { type: "confirmation", personId: o.personId });
        inFlight.set(toolUseID, auditId);
        return { behavior: "allow", updatedInput: input };
      }
      await completeAction(db, auditId, { status: o.result });
      releaseApprove(toolUseID);
      return { behavior: "deny", message: NOT_DONE[o.result] };
    } catch (err) {
      releaseApprove(toolUseID); // a failure here must not hold up the next approval
      throw err;
    }
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

  let signInLost = false;
  const scope: TurnScope = { personId: person.id, canUseTool, afterTool, confirmedBy, post: turn.routine?.post, graphToken: turn.graphToken, signInLost: () => void (signInLost = true) };
  let options: Options | undefined; // a cold run's, built only when one runs
  const prompt = withDefaults(turn.text, await getTenantSettings(db, tenantId), received);

  const auditMessage = async (summary: string, status: "done" | "failed", costUsd?: number, withTimings?: TurnTimings) => {
    const auditId = await beginAction(db, { ...base, kind: "message", summary: summary.slice(0, 200), model: definition.model, startedAt: received });
    await completeAction(db, auditId, { status, ...(costUsd !== undefined ? { costUsd } : {}), ...(withTimings ? { timings: withTimings } : {}) });
    return auditId;
  };

  const once = async (resume?: string): Promise<SDKResultMessage | undefined> => {
    resetTimings();
    options ??= setup.buildOptions(() => scope);
    for await (const msg of deps.queryFn({ prompt, options: { ...options, ...(resume ? { resume } : {}) } })) {
      observe(msg);
      if (msg.type === "result") return msg;
    }
    return undefined;
  };
  // one transient-network retry per turn, so with the warm process and the resume retry a turn runs at most four attempts
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
      await settle();
      return once(resume);
    }
  };
  // a "success" with is_error carries API error text in result, which must not reach the chat
  const succeeded = (msg?: SDKResultMessage) => msg?.subtype === "success" && !msg.is_error;

  // a run under a grant never shares the chat's process
  const live = ownSession ? undefined : deps.live;
  const liveKey = `${chatId}:${definition.id}`;
  const viaLive = async (pool: LiveSessions): Promise<SDKResultMessage> => {
    const turns = turnsOn(pool);
    if (turns.has(liveKey)) throw new Error("another turn is running on this live session");
    resetTimings();
    const sentAt = new Date().toISOString();
    let started = false;
    turns.set(liveKey, scope);
    try {
      const start = () => {
        started = true;
        return liveOptions(pool, liveKey, setup, session);
      };
      const msg = await pool.send(liveKey, setup.fingerprint, start, prompt, observe);
      // a warm process announces itself only once, so its engine is ready when the message goes in
      if (!started) Object.assign(timings, { live: true, engineReadyAt: sentAt });
      return msg;
    } finally {
      turns.delete(liveKey);
    }
  };
  // the first attempt: the warm process when there is one, else (or if it fails) a cold one as before
  const first = async (resume?: string): Promise<SDKResultMessage | undefined> => {
    if (!live) return attempt(resume);
    try {
      return await viaLive(live);
    } catch (err) {
      console.error("live engine failed, starting a cold one", err instanceof Error ? err.message : "unknown");
      await settle();
      return attempt(resume);
    }
  };

  try {
    let msg: SDKResultMessage | undefined;
    if (session) {
      try {
        msg = await first(session.sdkSessionId);
      } catch (err) {
        console.error("resume failed", err);
      }
      if (!succeeded(msg)) {
        // the transcript may be gone (redeploy, lost volume); start a fresh session once
        if (msg) await auditMessage(FAILED_TEXT, "failed", turnCost(msg.total_cost_usd));
        lastCost = 0; // a fresh session starts its own total
        await db.delete(sessions).where(and(eq(sessions.chatId, chatId), eq(sessions.definitionId, definition.id)));
        live?.close(liveKey); // it holds the session just given up
        await settle();
        msg = await attempt();
      }
    } else {
      msg = await first();
    }
    if (!msg) {
      await auditMessage(FAILED_TEXT, "failed");
      throw new Error("Agent SDK query ended without a result");
    }
    const ok = succeeded(msg);
    const text = ok && msg.subtype === "success" ? msg.result : FAILED_TEXT;
    const now = new Date();
    const costUsd = turnCost(msg.total_cost_usd);
    if (!ownSession)
      await db
        .insert(sessions)
        .values({ chatId, definitionId: definition.id, sdkSessionId: msg.session_id, lastCostUsd: String(msg.total_cost_usd), updatedAt: now })
        .onConflictDoUpdate({ target: [sessions.chatId, sessions.definitionId], set: { sdkSessionId: msg.session_id, lastCostUsd: String(msg.total_cost_usd), updatedAt: now } });
    const auditId = await auditMessage(text, ok ? "done" : "failed", costUsd, timings);
    return { text, costUsd, sessionId: msg.session_id, changed, timings, auditId, ...(signInLost ? { signInLost } : {}) };
  } finally {
    await settle(); // allowed but never finished (interrupted, maxTurns hit, stream died)
    await toolsRecorded;
  }
}

/** Starts the live process a turn on this chat and bot would use, resuming its stored session, without sending a message. Never throws. */
export async function prewarm(deps: RunnerDeps, key: { tenantId: string; chatId: string; definitionId: string }): Promise<void> {
  const { db, live } = deps;
  if (!live) return;
  try {
    const [chat] = await db.select({ tenantId: chats.tenantId }).from(chats).where(eq(chats.id, key.chatId));
    // the bot a message would reach now; a session left by a bot no longer assigned, or another tenant's, is not warmed
    const [definition] = await definitionsForChat(db, key.chatId);
    if (chat?.tenantId !== key.tenantId || definition?.id !== key.definitionId || definition.tenantId !== key.tenantId) {
      console.log("prewarm skipped", key.chatId);
      return;
    }
    const [session] = await db.select().from(sessions).where(and(eq(sessions.chatId, key.chatId), eq(sessions.definitionId, definition.id)));
    const setup = await engineSetup(deps, key.tenantId, key.chatId, definition, false);
    const liveKey = `${key.chatId}:${definition.id}`;
    live.warm(liveKey, setup.fingerprint, () => liveOptions(live, liveKey, setup, session));
    console.log("prewarmed", key.chatId);
  } catch (err) {
    console.error("prewarm failed", key.chatId, err instanceof Error ? err.name : "unknown");
  }
}

/** Warms the chats whose session was used within `withinMs`, most recent first, at most `max`, one at a time. Never throws. */
export async function prewarmRecent(deps: RunnerDeps, opts: { withinMs: number; max: number }): Promise<void> {
  try {
    const started = Date.now();
    const recent = await deps.db
      .select({ tenantId: chats.tenantId, chatId: sessions.chatId, definitionId: sessions.definitionId })
      .from(sessions)
      .innerJoin(chats, eq(sessions.chatId, chats.id))
      .where(gt(sessions.updatedAt, new Date(started - opts.withinMs)))
      .orderBy(desc(sessions.updatedAt))
      .limit(opts.max);
    for (const key of recent) await prewarm(deps, key);
    console.log(`prewarm done: ${recent.length} chats in ${Date.now() - started} ms`);
  } catch (err) {
    console.error("prewarm failed", err instanceof Error ? err.name : "unknown");
  }
}
