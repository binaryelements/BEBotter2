import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { confirmerPolicy } from "../admin/access.js";
import { auditInput, beginAction, completeAction, recordAuthority, summarise } from "../audit/audit.js";
import { mcpServerConfigs } from "../bots/definitions.js";
import { tellMcpServer } from "../bots/tell.js";
import { assistantMcpServer } from "../bots/assistant.js";
import { todoMcpServer } from "../todos/mcp.js";
import { connectionGrantForTool } from "../connections/store.js";
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
import { memoryNote, searchMemory, touchMemory } from "../memory/store.js";
import type { Db } from "../db/client.js";
import { assistantRequests, chats, departmentMembers, mailboxes, people, sessions } from "../db/schema.js";
import { getTenantSettings } from "../org/org.js";
import type { TenantSettings } from "../org/org.js";
import { decrypt } from "../secrets/cipher.js";
import { readMailAttachment } from "../mail/attachment.js";
import type { BotDefinition, Person, TurnTimings } from "../db/schema.js";

export type { TurnTimings };
import type { Confirmations, Outcome } from "./confirm.js";
import { browserMcpServer } from "./browser.js";
import type { Engine, EngineEvent, EngineMessage, EngineProcessOptions, EngineResult, EngineRunInput, EngineTool, ToolDecision } from "./engine.js";
import { FAILED_TEXT } from "./engine.js";
import { classify } from "./gate.js";
import type { McpServerConfig } from "./mcp.js";
import type { McpPool } from "./mcp-pool.js";
import { McpRegistry } from "./mcp-registry.js";
import { contextWindowFor, resolveModel } from "./providers.js";
import { recordTools, toolRule, toolRulesFor } from "./tool-rules.js";
import { compact, withoutImages } from "./transcript.js";

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
  /** A Word document's bytes from Markdown, for the person's create_document tool; without it that tool says so. */
  docx?: (markdown: string, title?: string) => Promise<Buffer> | Buffer;
  /** Built-in MCP servers (knowledge, connections, routine); `confirmedBy` names who confirmed the call now running. */
  builtinServers?: (ctx: { confirmedBy: () => string | undefined }) => Record<string, McpServerConfig>;
  /** Keeps stdio MCP clients alive between turns; without it every turn starts its own. */
  mcpPool?: McpPool;
  /** The owner's Graph token for a one-to-one chat, outside their own turn: a bot telling their assistant needs it. */
  personToken?: (chatId: string) => Promise<string | undefined>;
};
/** name: the bot's display name, when it has one; input: the call's arguments as the model sent them. */
export type ConfirmationRequest = { actionId: string; label: string; name?: string; toolName: string; input: Record<string, unknown> };
/** changed: a write completed under a routine grant, so the run must say what it did. */
export type RunResult = { text: string; costUsd: number; changed: boolean; timings: TurnTimings; /** the turn's message audit row */ auditId: string; /** Graph refused the person's token: sign them out so the next message brings the sign-in card */ signInLost?: boolean; /** A newer message stopped this turn before it answered; nothing was saved and the caller answers the newer message instead. */ aborted?: boolean };
/** delta: reply text as the model writes it; message-end: an assistant message finished. */
export type ProgressEvent = { kind: "text"; text: string } | { kind: "tool"; toolName: string } | { kind: "delta"; text: string } | { kind: "message-end" };

const MAX_AUDIT_INPUT = 2000;
const MAX_CARD_ARGS = 4000;
/** A long argument (a document's content, a mail body) is shown in the card as its first part and a count; the tool still gets all of it. */
const cardInput = (input: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === "string" && v.length > 2000 ? `${v.slice(0, 2000)}\n… (${v.length - 2000} more characters)` : v]));
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

/** Everything a turn's engine depends on. */
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
  const owner = personal ? (definition.ownerPersonId ?? ((await db.select({ o: chats.ownerPersonId }).from(chats).where(eq(chats.id, chatId)))[0]?.o ?? null)) : null;
  const learnt = await listLearnings(db, tenantId, definition.id, owner);
  const pending = personal
    ? await db
        .select({ id: assistantRequests.id, body: assistantRequests.body, from: people.name })
        .from(assistantRequests)
        .innerJoin(people, eq(people.id, assistantRequests.fromPersonId))
        .where(and(eq(assistantRequests.tenantId, tenantId), eq(assistantRequests.toDefinitionId, definition.id), eq(assistantRequests.status, "pending")))
        .limit(5)
    : [];
  const requestsNote = pending.length
    ? `\n\nRequests waiting from other assistants. Tell your owner who asked and what they want; use resolve_request only after your owner says yes or no: ${pending.map((r) => `#${r.id} from ${r.from}: ${r.body}`).join(" | ")}`
    : "";
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
  }${DEFAULTS_NOTE}${noComputer}${rulesText}${learningsNote(learnt)}${requestsNote}`;
  const processOptions: EngineProcessOptions = {
    model: definition.model,
    systemPrompt,
    // a chat turn gets 50 model calls: enough for a deep diagnosis with retries, still a guard against loops
    maxSteps: 50,
    cwd: deps.filesDir,
    webSearch: definition.webSearch,
    mcpServers: {
      ...mcpServerConfigs(definition, deps.secretsKey),
      ...(containerId ? { computer: computerMcpServer(deps.docker, containerId) } : {}),
      ...(definition.webSearch ? { browser: browserMcpServer() } : {}),
      // Personal reads shared notes but stores nothing and reaches no company systems: what it saw in one person's mail must not reach others
      // a personal assistant's own notes are stored against its definition, so they stay private to its owner
      knowledge: knowledgeMcpServer(deps, ctx, false),
      connections: connectionsMcpServer(deps, ctx),
      routine: routineMcpServer(deps, ctx),
      attachments: attachmentsMcpServer(deps, ctx),
      learnings: learningsMcpServer(deps, ctx, personal),
      // one bot tells another: the told bot runs its own turn here, for the same person, one hop at most
      bots: tellMcpServer({ db, run: (t) => runTurn(deps, t as RunTurnInput), ...(deps.personToken ? { personToken: deps.personToken } : {}) }, ctx),
      ...(definition.identity === "person" ? { assistant: assistantMcpServer({ db }, ctx) } : {}),
      ...(definition.identity === "person" ? { todos: todoMcpServer({ db }, ctx) } : {}),
      ...(definition.identity === "person" && definition.graph.length ? { m365: m365McpServer(deps, ctx, definition.graph) } : {}),
      ...(mail ? { mail: { type: "http" as const, url: `${deps.agentmailUrl}/mcp`, headers: { Authorization: `Bearer ${mail.key}` } } } : {}),
      ...deps.builtinServers?.({ confirmedBy: ctx.confirmedBy }),
      ...conn.servers,
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
  /** Aborted when the person sends another message: the turn stops, its tools are cancelled and nothing is delivered. */
  signal?: AbortSignal;
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
  const signal = turn.signal ?? new AbortController().signal;
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
  const key = `${chatId}:${definition.id}`;
  const setup = await engineSetup(deps, tenantId, chatId, definition, !!turn.routine, key);
  const { conn } = setup;
  // the long tail of memory: only the few relevant to this message are put in the prompt, never the whole table
  const personal = definition.identity === "person";
  const owner = personal ? (definition.ownerPersonId ?? ((await db.select({ o: chats.ownerPersonId }).from(chats).where(eq(chats.id, chatId)))[0]?.o ?? null)) : null;
  const departments = (await db.select({ id: departmentMembers.departmentId }).from(departmentMembers).where(eq(departmentMembers.personId, person.id))).map((r) => r.id);
  const remembered = await searchMemory(db, { tenantId, definitionId: definition.id, ownerPersonId: owner, departmentIds: departments, chatId }, turn.text, 12);
  if (remembered.length) await touchMemory(db, remembered.map((r) => r.id));
  const memoryText = memoryNote(remembered);

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
    if (signal.aborted) return stale();
    // a per-bot, per-connection permission sits above the global tool rule
    const perConnection = await connectionGrantForTool(db, tenantId, definition.id, toolName, input);
    if (perConnection?.mode === "deny") {
      await completeAction(db, auditId, { status: "denied" });
      return { allow: false, message: `Not done: this bot has no access to ${perConnection.name}.` };
    }
    if (perConnection?.mode === "read" && perConnection.change) {
      await completeAction(db, auditId, { status: "denied" });
      return { allow: false, message: `Not done: this bot's access to ${perConnection.name} is read-only.` };
    }
    let kind = classify(toolName, definition, conn.readOnly, rule);
    if (perConnection?.mode === "confirm" && perConnection.change) kind = "write";
    if (perConnection?.mode === "free" && perConnection.change) kind = "read";
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
      // the card shows every argument (long text in its first part), so a call too large to show is never asked
      if (JSON.stringify(cardInput(input), null, 2).length > MAX_CARD_ARGS) {
        await completeAction(db, auditId, { status: "denied" });
        releaseApprove(callId);
        return { allow: false, message: "Not done: the request was too large to show for confirmation." };
      }
      if (signal.aborted) {
        await completeAction(db, auditId, { status: "failed" });
        releaseApprove(callId);
        return STALE;
      }
      const { actionId, outcome } = deps.confirmations.create({ auditId, mayConfirm: confirmerPolicy(db, tenantId, definition.id, person.id, kind, chatId), chatId, personId: person.id, definitionId: definition.id });
      let o: Outcome | { result: "failed" } | { result: "aborted" };
      let offAbort = () => {};
      try {
        await turn.askConfirmation({ actionId, label: definition.label, ...(definition.displayName ? { name: definition.displayName } : {}), toolName, input: cardInput(input) });
        // a newer message stops the wait at once, so the old turn cannot run a tool after the person has moved on
        const aborted = new Promise<{ result: "aborted" }>((resolve) => {
          if (signal.aborted) return resolve({ result: "aborted" });
          const f = () => resolve({ result: "aborted" });
          signal.addEventListener("abort", f, { once: true });
          offAbort = () => signal.removeEventListener("abort", f);
        });
        o = await Promise.race([outcome, aborted]);
        offAbort();
        if (o.result === "aborted") {
          deps.confirmations.cancel([actionId]); // a late click must not run it either
          await completeAction(db, auditId, { status: "failed" });
          releaseApprove(callId);
          return STALE;
        }
      } catch (err) {
        offAbort();
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

  // the app's MCP client; it connects the servers this turn built and closes them at the end
  let registry: McpRegistry | undefined;
  let tools: EngineTool[] = [];

  const runEngine = (): Promise<EngineResult> => {
    const history: EngineMessage[] = [...(session?.messages ?? []), { role: "user", text: prompt }];
    const systemPrompt = session?.summary
      ? `${setup.processOptions.systemPrompt}\n\nEarlier in this conversation:\n${session.summary}${memoryText}`
      : `${setup.processOptions.systemPrompt}${memoryText}`;
    const input: EngineRunInput = {
      ...setup.processOptions,
      systemPrompt,
      // a background job works through many pages (each browser click is a step), so it gets more steps than a chat turn
      maxSteps: turn.routine?.background ? 100 : setup.processOptions.maxSteps,
      history,
      signal,
      onEvent,
      tools,
      callTool: async (name, args, callSignal) => {
        if (!registry) return { text: "No tool runtime.", isError: true };
        const result = await registry.call(name, args, callSignal ?? signal);
        // the bot's own mailbox hands back files as base64: read them the way chat and Outlook files are read
        return name === "mcp__mail__get_attachment" ? readMailAttachment(result, deps.readDocument) : result;
      },
      authoriseTool,
      completeTool,
      onAttemptStart: resetTimings,
    };
    return deps.engine.run(input);
  };

  try {
    turnContexts.set(key, context);
    registry = new McpRegistry(setup.processOptions.mcpServers, { fetch: deps.fetchFn, key, pool: deps.mcpPool });
    tools = await registry.listTools();
    const result = await runEngine();
    // a superseded turn leaves no trace: no session, no message audit row, no reply
    if (result.stopReason === "aborted" || signal.aborted)
      return { text: "", costUsd: result.usage.costUsd, changed, timings, auditId: "", aborted: true };
    timings.resultAt = new Date().toISOString();
    const ok = result.stopReason === "text";
    const text = ok ? result.text : FAILED_TEXT;
    const now = new Date();
    const costUsd = result.usage.costUsd;
    const provider = resolveModel(definition.model)?.provider.id ?? null;
    const kept = compact(result.messages, session?.summary ?? undefined, contextWindowFor(definition.model));
    if (!ownSession)
      await db
        .insert(sessions)
        .values({
          chatId,
          definitionId: definition.id,
          lastCostUsd: String(result.usage.costUsd),
          messages: withoutImages(kept.messages),
          summary: kept.summary ?? null,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          provider,
          model: definition.model,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [sessions.chatId, sessions.definitionId],
          set: {
            lastCostUsd: String(result.usage.costUsd),
            messages: withoutImages(kept.messages),
            summary: kept.summary ?? null,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            provider,
            model: definition.model,
            updatedAt: now,
          },
        });
    const auditId = await auditMessage(text, ok ? "done" : "failed", costUsd, timings);
    return { text, costUsd, changed, timings, auditId, ...(signInLost ? { signInLost } : {}) };
  } finally {
    await registry?.close();
    turnContexts.delete(key);
    await settle(); // allowed but never finished (interrupted, maxSteps hit, stream died)
    await toolsRecorded;
  }
}
