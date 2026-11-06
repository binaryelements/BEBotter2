import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { and, desc, eq, gt } from "drizzle-orm";
import { confirmerPolicy } from "../admin/access.js";
import { auditInput, beginAction, completeAction, recordAuthority, summarise } from "../audit/audit.js";
import { definitionsForChat, mcpServerConfigs } from "../bots/definitions.js";
import { tellMcpServer } from "../bots/tell.js";
import { ensureComputer } from "../computer/computer.js";
import type { DockerClient } from "../computer/docker.js";
import { computerMcpServer } from "../computer/mcp.js";
import { connectionsMcpServer } from "../connections/mcp.js";
import type { SshRunner } from "../connections/ssh.js";
import { connectionMcpConfigs } from "../connections/store.js";
import { m365McpServer } from "../graph/mcp.js";
import { knowledgeMcpServer } from "../knowledge/mcp.js";
import { routineMcpServer } from "../routines/mcp.js";
import { attachmentsMcpServer, chatAttachment } from "../teams/attachments.js";
import { learningsMcpServer } from "../learnings/mcp.js";
import { learningsNote, listLearnings } from "../learnings/store.js";
import type { Db } from "../db/client.js";
import { chats, mailboxes, sessions } from "../db/schema.js";
import { getTenantSettings } from "../org/org.js";
import type { TenantSettings } from "../org/org.js";
import { decrypt } from "../secrets/cipher.js";
import type { BotDefinition, Person, TurnTimings } from "../db/schema.js";

export type { TurnTimings };
import type { Confirmations, Outcome } from "./confirm.js";
import { browserMcpServer } from "./browser.js";
import type { Engine, EngineEvent, EngineProcessOptions, EngineResult, EngineRunInput, ToolDecision } from "./engine.js";
import { FAILED_TEXT } from "./engine.js";
import { classify } from "./gate.js";
import type { McpServerConfig } from "./mcp.js";
import { recordTools, toolRule, toolRulesFor } from "./tool-rules.js";

export type RunnerDeps = {
  db: Db;
  engine: Engine;
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
  /** The owner's Graph token for a one-to-one chat, outside their own turn: a bot telling their assistant needs it. */
  personToken?: (chatId: string) => Promise<string | undefined>;
};
/** name: the bot's display name, when it has one; input: the call's arguments as the model sent them. */
export type ConfirmationRequest = { actionId: string; label: string; name?: string; toolName: string; input: Record<string, unknown> };
/** changed: a write completed under a routine grant, so the run must say what it did. */
export type RunResult = { text: string; costUsd: number; sessionId: string; changed: boolean; timings: TurnTimings; /** the turn's message audit row */ auditId: string; /** Graph refused the person's token: sign them out so the next message brings the sign-in card */ signInLost?: boolean };
/** delta: reply text as the model writes it; message-end: an assistant message finished. */
export type ProgressEvent = { kind: "text"; text: string } | { kind: "tool"; toolName: string } | { kind: "delta"; text: string } | { kind: "message-end" };

const MAX_AUDIT_INPUT = 2000;
const MAX_CARD_ARGS = 4000;
const NOT_DONE = {
  denied: "Not done: declined in the chat.",
  expired: "Not done: nobody confirmed within 10 minutes. Tell the chat you did not do it.",
  failed: "Not done: the confirmation could not be sent.",
};

/** What the app's tools act for on one conversation key; a warm process outlives its turns. */
type TurnContext = {
  personId: string;
  person: Person;
  confirmedBy: () => string | undefined;
  post?: (text: string) => Promise<void>;
  graphToken?: () => Promise<string | undefined>;
  signInLost: () => void;
  askConfirmation: RunTurnInput["askConfirmation"];
  relay: number;
};
const turnContexts = new Map<string, TurnContext>();

/** Everything a turn's engine depends on, shared by turns and prewarm so a warmed process is the one a turn would start. */
async function engineSetup(deps: RunnerDeps, tenantId: string, chatId: string, definition: BotDefinition, routine: boolean, key: string) {
  const { db } = deps;
  // a computer that can't start (no Docker on this host, image missing) costs the bot its computer, not the whole reply
  const containerId = definition.computer
    ? await ensureComputer(db, deps.docker, deps.computerImage, definition.id).catch((e: { code?: string; message?: string }) => {
        console.error(`computer unavailable for ${definition.id}:`, e?.code ?? e?.message ?? "unknown");
        return undefined;
      })
    : undefined;
  const noComputer = definition.computer && !containerId ? " Your computer is switched on but could not start right now; if a task needs it, say so." : "";
  const conn = await connectionMcpConfigs(db, deps.secretsKey, tenantId, definition.id, deps.fetchFn);
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
  // a Personal assistant is one bot shared by everyone, so it reads only the shared learnings and its chat owner's own
  const personal = definition.identity === "person";
  const owner = personal ? ((await db.select({ o: chats.ownerPersonId }).from(chats).where(eq(chats.id, chatId)))[0]?.o ?? null) : null;
  const learnt = await listLearnings(db, tenantId, definition.id, owner);
  const rulesText =
    ruleNote("free", "An admin set these actions to run without a confirmation card, so run them and never say they need confirming") +
    ruleNote("confirm", "An admin set these actions to need a confirmation card in the chat");
  // the engine advertises cwd to MCP servers as the client root, so it must be the folder the files server serves
  mkdirSync(deps.filesDir, { recursive: true });
  // getters, never copies: servers built here must act for the turn running when a tool is called, not the one that started the process
  const turn = () => {
    const t = turnContexts.get(key);
    if (!t) throw new Error("no turn is running on this live session");
    return t;
  };
  const ctx = {
    tenantId,
    chatId,
    definitionId: definition.id,
    get personId() { return turn().personId; },
    // read when the servers are built too, so it is absent rather than an error with no turn; a chat process never posts
    get post() { return turnContexts.get(key)?.post; },
    confirmedBy: () => turnContexts.get(key)?.confirmedBy(),
    // asked on every Graph call, so a warm process uses the token of the turn running now; between turns there is none
    graphToken: async () => turnContexts.get(key)?.graphToken?.(),
    signInLost: () => turnContexts.get(key)?.signInLost(),
    attachment: (id: string) => chatAttachment(db, chatId, id),
    get person() { return turnContexts.get(key)?.person; },
    get relay() { return turnContexts.get(key)?.relay ?? 0; },
    get askConfirmation() { return turnContexts.get(key)?.askConfirmation; },
  };
  const systemPrompt = `${definition.persona}\n\n${definition.displayName ? `Your name is ${definition.displayName}. ` : ""}${
    mail
      ? `Your own email address is ${mail.address}.`
      : `You have no email address and cannot send or receive email${deps.agentmailUrl ? "; an admin can add one on the admin page" : ""}.`
  }${DEFAULTS_NOTE}${noComputer}${rulesText}${learningsNote(learnt)}`;
  const processOptions: EngineProcessOptions = {
    model: definition.model,
    systemPrompt,
    maxSteps: 25,
    cwd: deps.filesDir,
    webSearch: definition.webSearch,
    mcpServers: {
      ...mcpServerConfigs(definition, deps.secretsKey),
      ...(containerId ? { computer: computerMcpServer(deps.docker, containerId) } : {}),
      ...(definition.webSearch ? { browser: browserMcpServer() } : {}),
      // Personal reads shared notes but stores nothing and reaches no company systems: what it saw in one person's mail must not reach others
      knowledge: knowledgeMcpServer(deps, ctx, definition.identity === "person"),
      ...(definition.identity === "person" ? {} : { connections: connectionsMcpServer(deps, ctx) }),
      routine: routineMcpServer(deps, ctx),
      attachments: attachmentsMcpServer(deps, ctx),
      learnings: learningsMcpServer(deps, ctx, personal),
      // one bot tells another: the told bot runs its own turn here, for the same person, one hop at most
      bots: tellMcpServer({ db, run: (t) => runTurn(deps, t as RunTurnInput), ...(deps.personToken ? { personToken: deps.personToken } : {}) }, ctx),
      ...(definition.identity === "person" && definition.graph.length ? { m365: m365McpServer(deps, ctx, definition.graph) } : {}),
      ...(mail ? { mail: { type: "http" as const, url: `${deps.agentmailUrl}/mcp`, headers: { Authorization: `Bearer ${mail.key}` } } } : {}),
      ...deps.builtinServers?.({ confirmedBy: ctx.confirmedBy }),
      ...(definition.identity === "person" ? {} : conn.servers),
    },
  };
  // anything the options capture at start is in the fingerprint
  const fingerprint = createHash("sha256").update(JSON.stringify([definition.id, definition.updatedAt, definition.identity, definition.graph, containerId ?? null, conn, routine, rules, learnt.map((l) => [l.id, l.text]), mail ? [mailbox!.status, mail.keyId, mail.address] : null])).digest("hex");
  return { conn, processOptions, fingerprint };
}

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
  routine?: { id: string; grantPersonId: string | null; post: (text: string) => Promise<void>; background?: boolean };
  /** The person's Microsoft Graph token, asked for per call; only for person definitions. Never stored, logged or shown to the model. */
  graphToken?: () => Promise<string | undefined>;
  /** How many bots passed this on: a told bot (1) cannot tell further. */
  relay?: number;
};

/**
 * The message as the model gets it: first a line with the time now in the company's time zone and its default place.
 * Read on every turn, so a changed setting counts from the next message, warm process or not.
 */
export function withDefaults(text: string, s: Pick<TenantSettings, "timezone" | "location" | "country">, at: Date, person?: Pick<Person, "timezone" | "location">): string {
  // the person's own time zone (from their Teams client) and place (from the directory) come first; the company's are the fallback
  const timezone = person?.timezone ?? s.timezone;
  const now = new Intl.DateTimeFormat("en-AU", { timeZone: timezone, dateStyle: "full", timeStyle: "short" }).format(at);
  const place = person?.location ?? [s.location, s.country].filter(Boolean).join(", ");
  return `[${DEFAULTS_TAG} now ${now} (${timezone})${place ? `; location ${place}` : ""}]\n\n${text}`;
}
const DEFAULTS_TAG = "defaults:";
const DEFAULTS_NOTE = ` Each message starts with a line in square brackets that begins "${DEFAULTS_TAG}". The system adds it, not the person: the time now in the person's time zone, and where they are (or the company's defaults). Use them unless the person says otherwise in this chat, and then keep to what they said. Never mention the line itself.`;

export async function runTurn(deps: RunnerDeps, turn: RunTurnInput): Promise<RunResult> {
  const { db } = deps;
  const { tenantId, chatId, definition, person } = turn;
  const base = { tenantId, chatId, definitionId: definition.id, personId: person.id };
  const received = turn.receivedAt ?? new Date();
  const timings: TurnTimings = { receivedAt: received.toISOString(), tools: 0 };
  // phase bookkeeping for the engine's events; a warm runtime feeds the same events
  const report = (event: ProgressEvent) => {
    try {
      turn.progress?.(event);
    } catch (err) {
      console.error("progress callback failed", err); // a broken listener must not abort the turn
    }
  };
  // each attempt starts over, so the timings describe the attempt that answered
  const resetTimings = () => {
    for (const k of ["engineReadyAt", "firstOutputAt", "firstToolAt", "resultAt", "live"] as const) delete timings[k];
    timings.tools = 0;
  };
  // the engine's own tool list, for the admin page; awaited before the turn ends, and its failure never fails the turn
  let toolsRecorded = Promise.resolve();
  const onEvent = (event: EngineEvent) => {
    const at = new Date().toISOString();
    if (event.kind === "ready") {
      timings.engineReadyAt ??= at;
      if (event.warm) timings.live = true;
      return;
    }
    if (event.kind === "tools") {
      const tools = event.tools; // never trust the engine's message to be complete
      toolsRecorded = toolsRecorded.then(() => recordTools(db, definition.id, tools)).catch((e) => console.error("recording tools failed", e instanceof Error ? e.name : "unknown"));
      return;
    }
    if (event.kind === "delta") return report({ kind: "delta", text: event.text });
    if (event.kind === "message-end") return report({ kind: "message-end" });
    if (event.kind === "text") {
      timings.firstOutputAt ??= at;
      return report({ kind: "text", text: event.text });
    }
    timings.firstOutputAt ??= at;
    timings.firstToolAt ??= at;
    timings.tools++;
    report({ kind: "tool", toolName: event.toolName });
  };

  // a run under an admin grant starts clean: text from the chat must not steer it, and its context stays out of the chat's session;
  // a background job too, so the chat carries on beside it
  const ownSession = !!turn.routine?.grantPersonId || !!turn.routine?.background;
  const [session] = ownSession ? [] : await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.chatId, chatId), eq(sessions.definitionId, definition.id)));
  // the engine reports a session's running total, resumed sessions included; a turn's cost is the growth since the last one seen
  let lastCost = Number(session?.lastCostUsd ?? 0);
  const turnCost = (total: number) => (ownSession ? total : Math.round((total >= lastCost ? total - lastCost : total) * 1e6) / 1e6);
  const key = `${chatId}:${definition.id}`;
  const setup = await engineSetup(deps, tenantId, chatId, definition, !!turn.routine, key);
  const { conn } = setup;

  // tool use id → audit row of a call that was allowed and has not finished yet
  const inFlight = new Map<string, string>();
  const granted = new Set<string>(); // tool use ids allowed by a routine grant
  let changed = false;
  // Tool handlers never see the confirmation. Parallel calls may be confirmed in any order, so only an
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
  const STALE = { allow: false as const, message: "Not done: the attempt that asked has ended." };

  const authoriseTool = async (callId: string, toolName: string, input: Record<string, unknown>): Promise<ToolDecision> => {
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
      inFlight.set(callId, auditId);
      return { allow: true };
    }
    const grant = turn.routine?.grantPersonId;
    if (kind === "write" && grant) {
      await recordAuthority(db, auditId, { type: "grant", personId: grant, routineId: turn.routine!.id });
      inFlight.set(callId, auditId);
      granted.add(callId);
      return { allow: true };
    }
    if (kind === "approve") {
      const previous = approveTail;
      approveTail = new Promise<void>((resolve) => approveReleases.set(callId, resolve));
      await previous;
      if (run !== attemptNo) return stale();
    }
    try {
      // the card shows every argument, so a call too large to show is never asked
      if (JSON.stringify(input, null, 2).length > MAX_CARD_ARGS) {
        await completeAction(db, auditId, { status: "denied" });
        releaseApprove(callId);
        return { allow: false, message: "Not done: the request was too large to show for confirmation." };
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
        inFlight.set(callId, auditId);
        return { allow: true };
      }
      await completeAction(db, auditId, { status: o.result });
      releaseApprove(callId);
      return { allow: false, message: NOT_DONE[o.result] };
    } catch (err) {
      releaseApprove(callId); // a failure here must not hold up the next approval
      throw err;
    }
  };

  const completeTool = async (callId: string, status: "done" | "failed"): Promise<void> => {
    const auditId = inFlight.get(callId);
    if (!auditId) return;
    inFlight.delete(callId);
    releaseApprove(callId);
    await completeAction(db, auditId, { status });
    if (status === "done" && granted.has(callId)) changed = true;
  };

  let signInLost = false;
  // the app's tools read the turn through the key, so a warm process acts for whoever is talking now
  const context: TurnContext = {
    personId: person.id, person, confirmedBy, post: turn.routine?.post, graphToken: turn.graphToken, signInLost: () => void (signInLost = true),
    askConfirmation: turn.askConfirmation, relay: turn.relay ?? 0,
  };
  const prompt = withDefaults(turn.text, await getTenantSettings(db, tenantId), received, person);

  const auditMessage = async (summary: string, status: "done" | "failed", costUsd?: number, withTimings?: TurnTimings) => {
    const auditId = await beginAction(db, { ...base, kind: "message", summary: summary.slice(0, 200), model: definition.model, startedAt: received });
    await completeAction(db, auditId, { status, ...(costUsd !== undefined ? { costUsd } : {}), ...(withTimings ? { timings: withTimings } : {}) });
    return auditId;
  };

  // one engine run per attempt; the engine handles a transient-network retry and a warm-process fallback
  const runEngine = (checkpoint?: string): Promise<EngineResult> => {
    const input: EngineRunInput = {
      ...setup.processOptions,
      // a background job works through many pages (each browser click is a step), so it gets more steps than a chat turn
      maxSteps: turn.routine?.background ? 100 : setup.processOptions.maxSteps,
      key,
      fingerprint: setup.fingerprint,
      history: [{ role: "user", text: prompt }],
      useWarm: !ownSession,
      signal: new AbortController().signal,
      onEvent,
      authoriseTool,
      completeTool,
      onAttemptStart: resetTimings,
      onAttemptEnd: settle,
      ...(checkpoint ? { checkpoint } : {}),
    };
    return deps.engine.run(input);
  };

  try {
    turnContexts.set(key, context);
    let result: EngineResult | undefined;
    if (session) {
      try {
        result = await runEngine(session.sdkSessionId);
      } catch (err) {
        console.error("resume failed", err);
      }
      if (!result || result.stopReason !== "text") {
        // the transcript may be gone (redeploy, lost volume); start a fresh session once
        if (result) await auditMessage(FAILED_TEXT, "failed", turnCost(result.usage.costUsd));
        lastCost = 0; // a fresh session starts its own total
        await db.delete(sessions).where(and(eq(sessions.chatId, chatId), eq(sessions.definitionId, definition.id)));
        deps.engine.reset?.(key); // it holds the session just given up
        await settle();
        result = await runEngine();
      }
    } else {
      result = await runEngine();
    }
    if (!result) {
      await auditMessage(FAILED_TEXT, "failed");
      throw new Error("engine run ended without a result");
    }
    timings.resultAt = new Date().toISOString();
    const ok = result.stopReason === "text";
    const text = ok ? result.text : FAILED_TEXT;
    const now = new Date();
    const costUsd = turnCost(result.usage.costUsd);
    const checkpoint = result.checkpoint ?? session?.sdkSessionId;
    if (!ownSession && checkpoint)
      await db
        .insert(sessions)
        .values({ chatId, definitionId: definition.id, sdkSessionId: checkpoint, lastCostUsd: String(result.usage.costUsd), updatedAt: now })
        .onConflictDoUpdate({ target: [sessions.chatId, sessions.definitionId], set: { sdkSessionId: checkpoint, lastCostUsd: String(result.usage.costUsd), updatedAt: now } });
    const auditId = await auditMessage(text, ok ? "done" : "failed", costUsd, timings);
    return { text, costUsd, sessionId: checkpoint ?? "", changed, timings, auditId, ...(signInLost ? { signInLost } : {}) };
  } finally {
    turnContexts.delete(key);
    await settle(); // allowed but never finished (interrupted, maxTurns hit, stream died)
    await toolsRecorded;
  }
}

/** Starts the live process a turn on this chat and bot would use, resuming its stored session, without sending a message. Never throws. */
export async function prewarm(deps: RunnerDeps, key: { tenantId: string; chatId: string; definitionId: string }): Promise<void> {
  const { db, engine } = deps;
  if (!engine.prewarm) return;
  try {
    const [chat] = await db.select({ tenantId: chats.tenantId }).from(chats).where(eq(chats.id, key.chatId));
    // the bot a message would reach now; a session left by a bot no longer assigned, or another tenant's, is not warmed
    const [definition] = await definitionsForChat(db, key.chatId);
    if (chat?.tenantId !== key.tenantId || definition?.id !== key.definitionId || definition.tenantId !== key.tenantId) {
      console.log("prewarm skipped", key.chatId);
      return;
    }
    const liveKey = `${key.chatId}:${definition.id}`;
    const [session] = await db.select().from(sessions).where(and(eq(sessions.chatId, key.chatId), eq(sessions.definitionId, definition.id)));
    const setup = await engineSetup(deps, key.tenantId, key.chatId, definition, false, liveKey);
    await engine.prewarm({
      key: liveKey,
      fingerprint: setup.fingerprint,
      ...(session ? { checkpoint: session.sdkSessionId } : {}),
      start: () => setup.processOptions,
      // a tool call on a process with no turn running acts for nobody, and is audited as failed
      orphanTool: async (name, input) => {
        const auditId = await beginAction(db, { tenantId: key.tenantId, chatId: key.chatId, definitionId: definition.id, kind: "tool", toolName: name, summary: summarise(name, input) });
        await completeAction(db, auditId, { status: "failed" });
        return { allow: false, message: "Not done: no message is being answered." };
      },
    });
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
