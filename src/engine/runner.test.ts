import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type * as auditModule from "../audit/audit.js";
import { completeAction, listActions } from "../audit/audit.js";
vi.mock("../audit/audit.js", async (orig) => {
  const actual = await orig<typeof auditModule>();
  return { ...actual, completeAction: vi.fn(actual.completeAction) };
});
import { upsertDefinition } from "../bots/definitions.js";
import type { BotDefinitionInput } from "../bots/definitions.js";
import { fakeDockerClient } from "../computer/docker.js";
import { fakeSsh } from "../connections/ssh.js";
import type { Db } from "../db/client.js";
import { botDefinitions, chats, connections, mailboxes, sessions } from "../db/schema.js";
import { addLearning } from "../learnings/store.js";
import { rememberMemory } from "../memory/store.js";
import { requestConnection, setConnectionGrant } from "../connections/store.js";
import { encrypt } from "../secrets/cipher.js";
import { setRole } from "../org/directory.js";
import { testDb } from "../db/test-db.js";
import { setTenantSettings, upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { Confirmations } from "./confirm.js";
import type { Engine, EngineEvent, EngineMessage, EngineRunInput, EngineResult } from "./engine.js";
import { FAILED_TEXT } from "./engine.js";
import { runTurn, withDefaults } from "./runner.js";
import { knownTools, setToolRule } from "./tool-rules.js";
import type { ConfirmationRequest } from "./runner.js";

const key = Buffer.alloc(32, 9);
const calls: [string, Record<string, unknown>][] = [
  ["mcp__computer__bash", { command: "uptime" }],
  ["mcp__tickets__close_ticket", { id: 7 }],
];

type FakeOptions = {
  failTool?: string;
  result?: Partial<EngineResult>;
  calls?: [string, Record<string, unknown>][];
  events?: EngineEvent[];
  tools?: string[];
};

/** A fake engine: drives the app's gate and audit the way the real loop does, then returns a result. */
function fakeEngine(opts: FakeOptions = {}) {
  const seen: EngineRunInput[] = [];
  const decisions: (string | undefined)[] = [];
  const messages: (string | undefined)[] = [];
  const prompts: string[] = [];
  const engine: Engine = {
    async run(input) {
      seen.push(input);
      const last = [...input.history].reverse().find((m) => m.role === "user");
      if (last) prompts.push(last.text);
      for (const event of opts.events ?? []) input.onEvent(event);
      if (opts.tools) input.onEvent({ kind: "tools", tools: opts.tools });
      const history: EngineMessage[] = [...input.history];
      for (const [i, [name, args]] of (opts.calls ?? calls).entries()) {
        const id = `tu-${i}`;
        const decision = await input.authoriseTool(id, name, args);
        decisions.push(decision.allow ? "allow" : "deny");
        if (!decision.allow) {
          messages.push(decision.message);
          history.push({ role: "tool", toolCallId: id, text: decision.message, isError: true });
          continue;
        }
        await input.completeTool(id, name === opts.failTool ? "failed" : "done");
        history.push({ role: "tool", toolCallId: id, text: "ok", ...(name === opts.failTool ? { isError: true } : {}) });
      }
      const text = opts.result?.text ?? "Done.";
      history.push({ role: "assistant", text });
      return {
        text,
        messages: history,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0.001 },
        steps: 2,
        stopReason: "text",
        ...opts.result,
      };
    },
  };
  return { engine, seen, decisions, messages, prompts };
}

async function setup(db: Db, def: Partial<BotDefinitionInput> = {}) {
  await upsertTenant(db, { id: "t1" });
  await upsertChat(db, { id: "c1", tenantId: "t1", conversationType: "groupChat" });
  const definition = await upsertDefinition(db, key, "t1", {
    name: "ops",
    label: "Ops",
    persona: "You run ops.",
    mcpServers: [{ name: "tickets", transport: "http", url: "http://tickets.invalid/mcp", readOnlyTools: [] }],
    ...def,
  });
  const person = await upsertPerson(db, { tenantId: "t1", aadObjectId: "a1", name: "Ann" });
  // the confirmation tests drive close_ticket; bash runs freely here as an admin could set it
  await setToolRule(db, definition.id, "mcp__computer__bash", "free");
  return { definition, person };
}

const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), "bebotter2-files-"));

function deps(db: Db, engine: Engine, confirmations = new Confirmations()) {
  const docker = fakeDockerClient();
  return { db, engine, confirmations, secretsKey: key, docker, computerImage: "img", filesDir, ssh: fakeSsh(), publicUrl: "https://bot.example.test", fetchFn: (async () => new Response("ok")) as typeof fetch };
}

afterEach(() => vi.useRealTimers());

describe("runTurn", () => {
  it("carries the person's token closure but never puts the token in the input, prompt, audit or logs", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const token = "eyJ0b2stc2VjcmV0";
    const graphToken = vi.fn(async () => token);
    const logged: unknown[] = [];
    const spies = (["log", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a) => void logged.push(...a)));
    const q = fakeEngine();
    const confirmations = new Confirmations();
    await runTurn(deps(db, q.engine, confirmations), {
      tenantId: "t1", chatId: "c1", definition, person, text: "hi", graphToken,
      askConfirmation: async (req) => void confirmations.resolve(req.actionId, person.id, "yes"),
    });
    spies.forEach((s) => s.mockRestore());
    expect(q.seen).toHaveLength(1);
    const seen = new WeakSet<object>();
    const flat = JSON.stringify(q.seen, (_k, v: unknown) => (v && typeof v === "object" ? (seen.has(v) ? undefined : (seen.add(v), v)) : v));
    expect(flat).not.toContain(token);
    expect(String(q.seen[0]!.systemPrompt)).not.toContain(token);
    expect(Object.values(q.seen[0]!)).not.toContain(graphToken);
    expect(JSON.stringify(await listActions(db, { tenantId: "t1" }))).not.toContain(token);
    expect(JSON.stringify(logged)).not.toContain(token);
  });

  it("a throwing progress callback is logged and the turn still finishes", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const q = fakeEngine({ calls: [], events: [{ kind: "text", text: "Hi." }] });
    const result = await runTurn(deps(db, q.engine), { tenantId: "t1", chatId: "c1", definition, person, text: "hi", askConfirmation: async () => {}, progress: () => { throw new Error("boom"); } });
    expect(result.text).toBe("Done.");
    expect(err).toHaveBeenCalledWith("progress callback failed", expect.any(Error));
    err.mockRestore();
  });

  it("records phase timings on the message row and reports progress in order", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const q = fakeEngine({ calls: [], events: [{ kind: "ready" }, { kind: "text", text: "Looking." }, { kind: "tool", toolName: "WebSearch" }] });
    const events: unknown[] = [];
    const receivedAt = new Date(Date.now() - 5000);
    const result = await runTurn(deps(db, q.engine), { tenantId: "t1", chatId: "c1", definition, person, text: "hi", receivedAt, askConfirmation: async () => {}, progress: (e) => void events.push(e) });

    expect(events).toEqual([{ kind: "text", text: "Looking." }, { kind: "tool", toolName: "WebSearch" }]);
    const [row] = (await listActions(db, { tenantId: "t1" })).filter((r) => r.id === result.auditId);
    expect(row!.startedAt).toEqual(receivedAt);
    const t = row!.timings!;
    expect(t.receivedAt).toBe(receivedAt.toISOString());
    expect(t.tools).toBe(1);
    const order = [t.receivedAt, t.engineReadyAt, t.firstOutputAt, t.firstToolAt, t.resultAt].map((s) => Date.parse(s!));
    expect(order.every((n, i) => i === 0 || n >= order[i - 1]!)).toBe(true);
    expect(t.engineReadyAt && t.firstOutputAt && t.firstToolAt && t.resultAt).toBeTruthy();
  });

  it("reports the reply's text deltas and message ends", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const q = fakeEngine({ calls: [], events: [{ kind: "delta", text: "Hel" }, { kind: "delta", text: "lo" }, { kind: "message-end" }] });
    const events: unknown[] = [];
    await runTurn(deps(db, q.engine), { tenantId: "t1", chatId: "c1", definition, person, text: "hi", askConfirmation: async () => {}, progress: (e) => void events.push(e) });
    expect(events).toEqual([{ kind: "delta", text: "Hel" }, { kind: "delta", text: "lo" }, { kind: "message-end" }]);
  });

  it("a computer that cannot start leaves the bot without one and says so, and the reply still runs", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db, { computer: true });
    const q = fakeEngine({ calls: [] });
    const noDocker = new Proxy({}, { get: () => async () => { throw Object.assign(new Error("connect ENOENT /var/run/docker.sock"), { code: "ENOENT" }); } });
    const result = await runTurn({ ...deps(db, q.engine), docker: noDocker as never }, { tenantId: "t1", chatId: "c1", definition, person, text: "hi", askConfirmation: async () => {} });
    expect(result.text).toBe("Done.");
    expect(Object.keys(q.seen[0]!.mcpServers)).not.toContain("computer");
    expect(q.seen[0]!.systemPrompt).toContain("Your computer is switched on but could not start right now");
  });

  it("allows the read tool, confirms the write tool with the asker and audits both", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db, { computer: true });
    const q = fakeEngine();
    const d = deps(db, q.engine);
    const requests: ConfirmationRequest[] = [];
    const result = await runTurn(d, {
      tenantId: "t1", chatId: "c1", definition, person, text: "close 7",
      askConfirmation: async (req) => {
        requests.push(req);
        d.confirmations.resolve(req.actionId, person.id, "yes");
      },
    });

    expect(result).toMatchObject({ text: "Done.", costUsd: 0.001, changed: false });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({ actionId: expect.any(String), label: "Ops", toolName: "mcp__tickets__close_ticket", input: { id: 7 } });
    expect(Object.keys(q.seen[0]!.mcpServers).sort()).toEqual(["attachments", "bots", "computer", "connections", "knowledge", "learnings", "routine", "tickets"]);
    expect(q.seen[0]!.cwd).toBe(filesDir);

    const rows = await listActions(db, { tenantId: "t1" });
    const bash = rows.find((r) => r.toolName === "mcp__computer__bash")!;
    const close = rows.find((r) => r.toolName === "mcp__tickets__close_ticket")!;
    const message = rows.find((r) => r.kind === "message")!;
    expect(bash.status).toBe("done");
    expect(bash.authority).toBeNull();
    expect(close.status).toBe("done");
    expect(close.authority).toEqual({ type: "confirmation", personId: person.id });
    expect(message).toMatchObject({ status: "done", summary: "Done.", costUsd: "0.001000", model: definition.model });
  });

  it("confirmed write records the clicker as authority", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const boss = await upsertPerson(db, { tenantId: "t1", aadObjectId: "boss", name: "Boss" });
    await setRole(db, "t1", boss.id, "admin");
    const q = fakeEngine({ calls: [["mcp__tickets__close_ticket", { id: 7 }]] });
    const d = deps(db, q.engine);
    await runTurn(d, { tenantId: "t1", chatId: "c1", definition, person, text: "x", askConfirmation: async (r) => void (await d.confirmations.resolve(r.actionId, boss.id, "yes")) });
    const row = (await listActions(db, { tenantId: "t1" })).find((r) => r.kind === "tool")!;
    expect(row.authority).toEqual({ type: "confirmation", personId: boss.id });
  });

  it("routine with a grant runs a write tool without a card and records grant authority", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const q = fakeEngine({ calls: [["mcp__tickets__close_ticket", { id: 7 }]] });
    const asked: ConfirmationRequest[] = [];
    const result = await runTurn(deps(db, q.engine), {
      tenantId: "t1", chatId: "c1", definition, person, text: "x", askConfirmation: async (r) => void asked.push(r),
      routine: { id: "r1", grantPersonId: person.id, post: async () => {} },
    });
    expect(result.changed).toBe(true);
    expect(asked).toEqual([]);
    const row = (await listActions(db, { tenantId: "t1" })).find((r) => r.kind === "tool")!;
    expect(row).toMatchObject({ status: "done", authority: { type: "grant", personId: person.id, routineId: "r1" } });
  });

  it("a granted routine run uses its own session and leaves the chat's alone", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    await db.insert(sessions).values({ chatId: "c1", definitionId: definition.id, sdkSessionId: "chat-session", updatedAt: new Date() });
    const q = fakeEngine({ calls: [] });
    await runTurn(deps(db, q.engine), {
      tenantId: "t1", chatId: "c1", definition, person, text: "do the thing", askConfirmation: async () => {},
      routine: { id: "r1", grantPersonId: person.id, post: async () => {} },
    });
    expect(q.seen[0]!.history).toHaveLength(1);
    expect((await db.select().from(sessions))[0]!.sdkSessionId).toBe("chat-session");
  });

  it("a background job gets more steps and leaves the chat's session alone", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    await db.insert(sessions).values({ chatId: "c1", definitionId: definition.id, sdkSessionId: "chat-session", updatedAt: new Date() });
    const q = fakeEngine({ calls: [] });
    await runTurn(deps(db, q.engine), {
      tenantId: "t1", chatId: "c1", definition, person, text: "compare fares", askConfirmation: async () => {},
      routine: { id: "r1", grantPersonId: null, post: async () => {}, background: true },
    });
    expect(q.seen[0]!.maxSteps).toBe(100);
    expect((await db.select().from(sessions))[0]!.sdkSessionId).toBe("chat-session");
  });

  it("web search brings the browser, as desktop Chrome on Linux; without it there is none", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const q = fakeEngine({ calls: [] });
    await runTurn(deps(db, q.engine), { tenantId: "t1", chatId: "c1", definition: { ...definition, webSearch: true }, person, text: "x", askConfirmation: async () => {} });
    await runTurn(deps(db, q.engine), { tenantId: "t1", chatId: "c1", definition: { ...definition, webSearch: false }, person, text: "x", askConfirmation: async () => {} });
    expect(q.seen[0]!.mcpServers.browser).toMatchObject({ type: "stdio", args: expect.arrayContaining(["--headless", "--isolated", expect.stringMatching(/X11; Linux x86_64.*Chrome\/\d+/)]) });
    expect(q.seen[0]!.webSearch).toBe(true);
    expect(q.seen.at(-1)!.mcpServers).not.toHaveProperty("browser");
  });

  it("what the bot was taught is in its instructions from the next turn; on Personal only the chat owner's own and the shared ones", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const bob = await upsertPerson(db, { tenantId: "t1", aadObjectId: "b1", name: "Bob" });
    const q = fakeEngine({ calls: [] });
    const turn = (def = definition) => runTurn(deps(db, q.engine), { tenantId: "t1", chatId: "c1", definition: def, person, text: "x", askConfirmation: async () => {} });
    await turn();
    expect(String(q.seen[0]!.systemPrompt)).not.toContain("taught you");
    await addLearning(db, "t1", { definitionId: definition.id, text: "Call scheduled runs reminders", taughtByPersonId: person.id, chatId: "c1" });
    await addLearning(db, "t1", { definitionId: definition.id, text: "Bob's wife is Jo", taughtByPersonId: bob.id, ownerPersonId: bob.id });
    await turn();
    expect(String(q.seen.at(-1)!.systemPrompt)).toContain("- Call scheduled runs reminders");
    expect(String(q.seen.at(-1)!.systemPrompt)).not.toContain("Jo");
    expect(q.seen.at(-1)!.mcpServers).toHaveProperty("learnings");
    const personal = { ...definition, identity: "person" as const, mcpServers: [] };
    await db.update(chats).set({ ownerPersonId: bob.id }).where(eq(chats.id, "c1"));
    await turn(personal);
    expect(String(q.seen.at(-1)!.systemPrompt)).toMatch(/- Call scheduled runs reminders\n- Bob's wife is Jo/);
  });

  it("a saved server named like a built-in neither loads nor shadows it", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const legacy = { ...definition, mcpServers: [{ name: "Knowledge", transport: "http" as const, url: "http://evil.invalid/mcp", readOnlyTools: [] }, { name: "knowledge", transport: "http" as const, url: "http://evil.invalid/mcp", readOnlyTools: [] }] };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const q = fakeEngine({ calls: [] });
    await runTurn(deps(db, q.engine), { tenantId: "t1", chatId: "c1", definition: legacy, person, text: "x", askConfirmation: async () => {} });
    errors.mockRestore();
    expect(q.seen[0]!.mcpServers).not.toHaveProperty("Knowledge");
    expect(q.seen[0]!.mcpServers.knowledge).not.toMatchObject({ type: "http" });
  });

  it("approve-class tool asks for a card even with a grant", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const boss = await upsertPerson(db, { tenantId: "t1", aadObjectId: "boss", name: "Boss" });
    await setRole(db, "t1", boss.id, "admin");
    const q = fakeEngine({ calls: [["mcp__connections__approve", { name: "x" }]] });
    const asked: ConfirmationRequest[] = [];
    const d = deps(db, q.engine);
    await runTurn(d, {
      tenantId: "t1", chatId: "c1", definition, person, text: "x",
      askConfirmation: async (r) => { asked.push(r); await d.confirmations.resolve(r.actionId, boss.id, "no"); },
      routine: { id: "r1", grantPersonId: person.id, post: async () => {} },
    });
    expect(asked).toHaveLength(1);
    const row = (await listActions(db, { tenantId: "t1" })).find((r) => r.kind === "tool")!;
    expect(row).toMatchObject({ status: "denied", authority: null });
  });

  it("an admin's rule frees a write and asks for a read, but never frees an approval", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const boss = await upsertPerson(db, { tenantId: "t1", aadObjectId: "boss", name: "Boss" });
    await setRole(db, "t1", boss.id, "admin");
    await setToolRule(db, definition.id, "mcp__tickets__close_ticket", "free");
    await setToolRule(db, definition.id, "mcp__computer__bash", "confirm");
    await setToolRule(db, definition.id, "mcp__connections__approve", "free");
    const q = fakeEngine({ calls: [["mcp__tickets__close_ticket", { id: 7 }], ["mcp__computer__bash", { command: "uptime" }], ["mcp__connections__approve", { name: "x" }], ["mcp__tickets__new_tool", {}]] });
    const asked: string[] = [];
    const d = deps(db, q.engine);
    await runTurn(d, { tenantId: "t1", chatId: "c1", definition, person, text: "x", askConfirmation: async (r) => { asked.push(r.toolName); await d.confirmations.resolve(r.actionId, boss.id, "no"); } });
    expect(asked).toEqual(["mcp__computer__bash", "mcp__connections__approve", "mcp__tickets__new_tool"]);
    expect(q.decisions).toEqual(["allow", "deny", "deny", "deny"]);
  });

  it("records the tools the engine announces, and a later turn adds new ones", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const first = fakeEngine({ calls: [], tools: ["WebSearch", "mcp__mail__send_email"] });
    await runTurn(deps(db, first.engine), { tenantId: "t1", chatId: "c1", definition, person, text: "hi", askConfirmation: async () => {} });
    expect(await knownTools(db, definition.id)).toEqual(["WebSearch", "mcp__mail__send_email"]);
    const second = fakeEngine({ calls: [], tools: ["WebSearch", "mcp__knowledge__read"] });
    await runTurn(deps(db, second.engine), { tenantId: "t1", chatId: "c1", definition, person, text: "hi", askConfirmation: async () => {} });
    expect(await knownTools(db, definition.id)).toEqual(["WebSearch", "mcp__knowledge__read", "mcp__mail__send_email"]);
  });

  it("a failure while preparing an approval does not hold up the next one", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const boss = await upsertPerson(db, { tenantId: "t1", aadObjectId: "boss", name: "Boss" });
    await setRole(db, "t1", boss.id, "admin");
    const d = deps(db, undefined as unknown as Engine);
    const create = d.confirmations.create.bind(d.confirmations);
    let n = 0;
    d.confirmations.create = (o) => { if (n++ === 0) throw new Error("boom"); return create(o); };
    const outcomes: string[] = [];
    d.engine = {
      async run(input) {
        outcomes.push(await input.authoriseTool("tu-1", "mcp__connections__approve", { name: "x" }).then(() => "ok", () => "threw"));
        const decision = await input.authoriseTool("tu-2", "mcp__connections__approve", { name: "x" });
        outcomes.push(decision.allow ? "allow" : "deny");
        return { text: "Done.", messages: input.history, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, steps: 1, stopReason: "text" };
      },
    };
    await runTurn(d, { tenantId: "t1", chatId: "c1", definition, person, text: "x", askConfirmation: async (r) => void (await d.confirmations.resolve(r.actionId, boss.id, "no")) });
    expect(outcomes).toEqual(["threw", "deny"]);
  });

  it("confirmedBy is cleared once the approved tool has finished", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const boss = await upsertPerson(db, { tenantId: "t1", aadObjectId: "boss", name: "Boss" });
    await setRole(db, "t1", boss.id, "admin");
    const q = fakeEngine({ calls: [["mcp__connections__approve", { name: "x" }]] });
    const d = { ...deps(db, q.engine), builtinServers: ({ confirmedBy }: { confirmedBy: () => string | undefined }) => ({ probe: { confirmedBy } as never }) };
    const seenBefore = { v: "unset" as string | undefined };
    await runTurn(d, {
      tenantId: "t1", chatId: "c1", definition, person, text: "x",
      askConfirmation: async (r) => {
        seenBefore.v = (q.seen[0]!.mcpServers.probe as unknown as { confirmedBy: () => string | undefined }).confirmedBy();
        expect(await d.confirmations.resolve(r.actionId, person.id, "yes")).toBe("not_allowed");
        await d.confirmations.resolve(r.actionId, boss.id, "yes");
      },
    });
    expect(seenBefore.v).toBeUndefined();
    expect((q.seen[0]!.mcpServers.probe as unknown as { confirmedBy: () => string | undefined }).confirmedBy()).toBeUndefined();
  });

  it("audits two identical parallel calls on their own rows", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db, { computer: true });
    const q = fakeEngine({ calls: [["mcp__computer__bash", { command: "uptime" }], ["mcp__computer__bash", { command: "uptime" }]] });
    await runTurn(deps(db, q.engine), { tenantId: "t1", chatId: "c1", definition, person, text: "hi", askConfirmation: async () => {} });
    const rows = (await listActions(db, { tenantId: "t1" })).filter((r) => r.kind === "tool");
    expect(rows.map((r) => r.status)).toEqual(["done", "done"]);
  });

  it("denies a write call too large to show without asking", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const q = fakeEngine({ calls: [["mcp__tickets__close_ticket", { id: 7, note: "x".repeat(4000) }]] });
    const asked: ConfirmationRequest[] = [];
    await runTurn(deps(db, q.engine), { tenantId: "t1", chatId: "c1", definition, person, text: "hi", askConfirmation: async (r) => void asked.push(r) });
    expect(asked).toEqual([]);
    expect(q.decisions).toEqual(["deny"]);
    expect(q.messages).toEqual(["Not done: the request was too large to show for confirmation."]);
    const row = (await listActions(db, { tenantId: "t1" })).find((r) => r.kind === "tool")!;
    expect(row.status).toBe("denied");
  });

  it("denies the write tool when the confirmation expires and still returns the result", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const db = await testDb();
    const { definition, person } = await setup(db);
    const q = fakeEngine();
    let asked!: () => void;
    const askedP = new Promise<void>((r) => { asked = r; });
    const run = runTurn(deps(db, q.engine, new Confirmations(setTimeout)), {
      tenantId: "t1", chatId: "c1", definition, person, text: "close 7",
      askConfirmation: async () => asked(),
    });
    await askedP;
    await vi.advanceTimersByTimeAsync(600_000);
    const result = await run;

    expect(result.text).toBe("Done.");
    const rows = await listActions(db, { tenantId: "t1" });
    expect(rows.find((r) => r.toolName === "mcp__tickets__close_ticket")!.status).toBe("expired");
    expect(q.messages).toEqual(["Not done: nobody confirmed within 10 minutes. Tell the chat you did not do it."]);
    expect(rows.find((r) => r.toolName === "mcp__computer__bash")!.status).toBe("done");
  });

  it("saves the neutral transcript and replays it on the next turn", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const q = fakeEngine({ calls: [] });
    const d = deps(db, q.engine);
    const turn = {
      tenantId: "t1", chatId: "c1", definition, person, text: "hi",
      askConfirmation: async (_req: ConfirmationRequest) => {},
    };
    await runTurn(d, turn);
    expect(q.seen[0]!.history).toHaveLength(1);
    const [row] = await db.select().from(sessions);
    expect(row).toMatchObject({ chatId: "c1", definitionId: definition.id, sdkSessionId: null });
    expect(row!.messages).toHaveLength(2);
    await runTurn(d, turn);
    expect(q.seen[1]!.history).toHaveLength(3);
    expect(await db.select().from(sessions)).toHaveLength(1);
  });

  it("a failing settle never replaces the answer", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const engine: Engine = {
      async run(input) {
        await input.authoriseTool("tu-0", "mcp__tickets__close_ticket", { id: 7 });
        return { text: "Done.", messages: input.history, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, steps: 1, stopReason: "text" };
      },
    };
    const actualComplete = (await vi.importActual<typeof auditModule>("../audit/audit.js")).completeAction;
    vi.mocked(completeAction).mockImplementation(async (...a) => {
      if (a[2].status === "failed") throw new Error("db down");
      return actualComplete(...a);
    });
    try {
      const result = await runTurn(deps(db, engine), {
        tenantId: "t1", chatId: "c1", definition, person, text: "hi", askConfirmation: async () => {},
        routine: { id: "r1", grantPersonId: person.id, post: async () => {} },
      });
      expect(result.text).toBe("Done.");
      expect(err).toHaveBeenCalledWith("closing an unfinished action failed", "db down");
    } finally {
      vi.mocked(completeAction).mockImplementation(actualComplete);
      err.mockRestore();
    }
  });

  it("leaves out the computer when the definition has none", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const q = fakeEngine();
    const d = deps(db, q.engine);
    await runTurn(d, {
      tenantId: "t1", chatId: "c1", definition, person, text: "hi",
      askConfirmation: async (req) => { d.confirmations.resolve(req.actionId, person.id, "no"); },
    });
    expect(q.seen[0]!.mcpServers).not.toHaveProperty("computer");
    expect(d.docker.calls).toEqual([]);
  });

  it("records a failed message when the result is not a success", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const q = fakeEngine({ calls: [], result: { stopReason: "error", text: "secret", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0.5 } } });
    const result = await runTurn(deps(db, q.engine), {
      tenantId: "t1", chatId: "c1", definition, person, text: "hi", askConfirmation: async () => {},
    });
    expect(result).toMatchObject({ text: FAILED_TEXT, costUsd: 0.5, changed: false });
    const [row] = await listActions(db, { tenantId: "t1" });
    expect(row).toMatchObject({ kind: "message", status: "failed" });
  });

  it("fails the audit row of a tool that errors", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db, { computer: true });
    const q = fakeEngine({ failTool: "mcp__computer__bash" });
    await runTurn(deps(db, q.engine), {
      tenantId: "t1", chatId: "c1", definition, person, text: "hi", askConfirmation: () => Promise.reject(new Error("teams down")),
    });
    const rows = await listActions(db, { tenantId: "t1" });
    expect(rows.find((r) => r.toolName === "mcp__computer__bash")!.status).toBe("failed");
  });

  it("denies the write tool and fails its row when askConfirmation rejects", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = await testDb();
    const { definition, person } = await setup(db);
    const q = fakeEngine();
    const result = await runTurn(deps(db, q.engine), {
      tenantId: "t1", chatId: "c1", definition, person, text: "hi", askConfirmation: () => Promise.reject(new Error("teams down")),
    });
    expect(result.text).toBe("Done.");
    expect(q.decisions).toEqual(["allow", "deny"]);
    expect(q.messages).toEqual(["Not done: the confirmation could not be sent."]);
    expect(errors).toHaveBeenCalledWith("confirmation card failed", expect.any(Error));
    errors.mockRestore();
    const rows = await listActions(db, { tenantId: "t1" });
    expect(rows.find((r) => r.toolName === "mcp__tickets__close_ticket")!.status).toBe("failed");
  });

  it("does not send the error text of a failed result", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const q = fakeEngine({ calls: [], result: { stopReason: "error", text: "API Error: 500 internal" } });
    const result = await runTurn(deps(db, q.engine), {
      tenantId: "t1", chatId: "c1", definition, person, text: "hi", askConfirmation: () => Promise.reject(new Error("teams down")),
    });
    expect(result.text).toBe(FAILED_TEXT);
    const message = (await listActions(db, { tenantId: "t1" })).find((r) => r.kind === "message")!;
    expect(message).toMatchObject({ status: "failed", summary: FAILED_TEXT });
  });

  it("an approved mcp connection is attached as conn-<name> and its listed tools run without a card", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const { connection } = await requestConnection({ db, ssh: fakeSsh(), secretsKey: key }, "t1", {
      kind: "mcp", name: "desk", target: "https://mcp.example.test/mcp", mode: "read-only", config: { headerName: "X-Api-Key", readOnlyTools: ["list_tickets"] }, definitionId: definition.id, personId: person.id,
    });
    await db.update(connections).set({ status: "active", secretCipher: encrypt(key, "mcp-tok") }).where(eq(connections.id, connection.id));
    const q = fakeEngine({ calls: [["mcp__conn-desk__list_tickets", {}], ["mcp__conn-desk__close_ticket", { id: 1 }]] });
    const d = deps(db, q.engine);
    const requests: ConfirmationRequest[] = [];
    await runTurn(d, {
      tenantId: "t1", chatId: "c1", definition, person, text: "x",
      askConfirmation: async (r) => {
        requests.push(r);
        d.confirmations.resolve(r.actionId, person.id, "no");
      },
    });
    expect(q.seen[0]!.mcpServers["conn-desk"]).toEqual({ type: "http", url: "https://mcp.example.test/mcp", headers: { "X-Api-Key": "mcp-tok" } });
    expect(q.decisions).toEqual(["allow", "deny"]);
    expect(requests.map((r) => [r.toolName, r.input])).toEqual([["mcp__conn-desk__close_ticket", { id: 1 }]]);
  });

  it("a per-connection grant narrows or frees one bot without changing the global tool rule", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const { connection } = await requestConnection({ db, ssh: fakeSsh(), secretsKey: key }, "t1", {
      kind: "mcp", name: "desk", target: "https://mcp.example.test/mcp", mode: "change", config: { headerName: "X-Api-Key", readOnlyTools: ["list_tickets"] }, definitionId: definition.id, personId: person.id,
    });
    await db.update(connections).set({ status: "active", secretCipher: encrypt(key, "mcp-tok") }).where(eq(connections.id, connection.id));
    const calls: [string, Record<string, unknown>][] = [["mcp__conn-desk__close_ticket", { id: 1 }], ["mcp__conn-desk__list_tickets", {}]];
    const run = async (mode: "read" | "free" | "confirm") => {
      await setConnectionGrant(db, "t1", definition.id, connection.id, mode);
      const q = fakeEngine({ calls });
      const d = deps(db, q.engine);
      const requests: ConfirmationRequest[] = [];
      await runTurn(d, {
        tenantId: "t1", chatId: "c1", definition, person, text: "x",
        askConfirmation: async (r) => {
          requests.push(r);
          await d.confirmations.resolve(r.actionId, person.id, "yes");
        },
      });
      return { q, requests };
    };
    const read = await run("read");
    expect(read.q.decisions).toEqual(["deny", "allow"]);
    expect(read.requests).toEqual([]);
    const free = await run("free");
    expect(free.q.decisions).toEqual(["allow", "allow"]);
    expect(free.requests).toEqual([]);
    await setToolRule(db, definition.id, "mcp__conn-desk__close_ticket", "free");
    const confirm = await run("confirm");
    expect(confirm.q.decisions).toEqual(["allow", "allow"]);
    expect(confirm.requests.map((r) => r.toolName)).toEqual(["mcp__conn-desk__close_ticket"]);
  });

  it("a person definition gets no linked connection", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const { connection } = await requestConnection({ db, ssh: fakeSsh(), secretsKey: key }, "t1", {
      kind: "mcp", name: "desk", target: "https://mcp.example.test/mcp", mode: "read-only", config: { headerName: "X-Api-Key", readOnlyTools: ["list_tickets"] }, definitionId: definition.id, personId: person.id,
    });
    await db.update(connections).set({ status: "active", secretCipher: encrypt(key, "mcp-tok") }).where(eq(connections.id, connection.id));
    const q = fakeEngine({ calls: [] });
    await runTurn(deps(db, q.engine), { tenantId: "t1", chatId: "c1", definition: { ...definition, identity: "person", graph: [] }, person, text: "x", askConfirmation: async () => {} });
    expect(Object.keys(q.seen[0]!.mcpServers)).not.toContain("conn-desk");
  });

  it("an active mailbox attaches the mail server with the bot's key; sends ask, reads do not", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    await db.update(botDefinitions).set({ displayName: "Ada" }).where(eq(botDefinitions.id, definition.id));
    const named = { ...definition, displayName: "Ada", mcpServers: [{ name: "Mail", transport: "http" as const, url: "http://evil.invalid/mcp", readOnlyTools: ["send_email"] }] };
    await db.insert(mailboxes).values({ definitionId: definition.id, tenantId: "t1", agent: "bb2-x", localPart: "ada", inboxId: "i1", address: "ada@mail.example.test", keyId: "k1", keyCipher: encrypt(key, "am_botkey"), status: "active" });
    const q = fakeEngine({ calls: [["mcp__mail__list_messages", {}], ["mcp__mail__send_email", { to: "x@example.test" }]] });
    const d = { ...deps(db, q.engine), agentmailUrl: "https://mail.example.test" };
    const requests: ConfirmationRequest[] = [];
    await runTurn(d, { tenantId: "t1", chatId: "c1", definition: named, person, text: "x", askConfirmation: async (r) => void (requests.push(r), d.confirmations.resolve(r.actionId, person.id, "no")) });
    expect(q.seen[0]!.mcpServers.mail).toEqual({ type: "http", url: "https://mail.example.test/mcp", headers: { Authorization: "Bearer am_botkey" } });
    expect(q.seen[0]!.mcpServers).not.toHaveProperty("Mail");
    expect(q.seen[0]!.systemPrompt).toContain("Ada");
    expect(q.seen[0]!.systemPrompt).toContain("ada@mail.example.test");
    expect(q.decisions).toEqual(["allow", "deny"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ name: "Ada", label: "Ops", toolName: "mcp__mail__send_email" });
  });

  it("no mail server when the mailbox is removed or mail is not configured", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    await db.insert(mailboxes).values({ definitionId: definition.id, tenantId: "t1", agent: "bb2-x", localPart: "ada", inboxId: "i1", address: "ada@mail.example.test", keyId: "k1", keyCipher: encrypt(key, "am_botkey"), status: "active" });
    const q = fakeEngine({ calls: [] });
    const ask = async () => {};
    await runTurn(deps(db, q.engine), { tenantId: "t1", chatId: "c1", definition, person, text: "a", askConfirmation: ask });
    await db.update(mailboxes).set({ status: "removed", keyId: null, keyCipher: null }).where(eq(mailboxes.definitionId, definition.id));
    await runTurn({ ...deps(db, q.engine), agentmailUrl: "https://mail.example.test" }, { tenantId: "t1", chatId: "c1", definition, person, text: "b", askConfirmation: ask });
    expect(q.seen.map((o) => Object.keys(o.mcpServers).includes("mail"))).toEqual([false, false]);
    for (const o of q.seen) {
      expect(o.systemPrompt).toContain("cannot send or receive email");
      expect(o.systemPrompt).not.toContain("ada@mail.example.test");
    }
  });

  it("the no-mail prompt mentions the admin page only when mail is configured", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const q = fakeEngine({ calls: [] });
    const ask = async () => {};
    await runTurn(deps(db, q.engine), { tenantId: "t1", chatId: "c1", definition, person, text: "a", askConfirmation: ask });
    await runTurn({ ...deps(db, q.engine), agentmailUrl: "https://mail.example.test" }, { tenantId: "t1", chatId: "c1", definition, person, text: "b", askConfirmation: ask });
    expect(String(q.seen[0]!.systemPrompt)).toContain("cannot send or receive email.");
    expect(String(q.seen[0]!.systemPrompt)).not.toContain("admin page");
    expect(String(q.seen[1]!.systemPrompt)).toContain("an admin can add one on the admin page");
  });

  it("puts only the relevant long-term memory in the system prompt", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    for (let i = 0; i < 15; i++) await rememberMemory(db, { tenantId: "t1", definitionId: definition.id, text: `unrelated memory ${i}`, importance: 2 });
    await rememberMemory(db, { tenantId: "t1", definitionId: definition.id, text: "BE Voice: check the SIP trunk registration first", kind: "procedure", importance: 5 });
    const q = fakeEngine({ calls: [] });
    await runTurn(deps(db, q.engine), { tenantId: "t1", chatId: "c1", definition, person, text: "The BE Voice trunk is down", askConfirmation: async () => {} });
    const prompt = String(q.seen[0]!.systemPrompt);
    expect(prompt).toContain("Relevant long-term memory");
    expect(prompt).toContain("check the SIP trunk registration first");
    // 16 items exist, but the prompt gets the capped selection, not the table
    expect(prompt).not.toContain("unrelated memory 0");
    expect(prompt.split("\n").filter((l) => l.startsWith("- [")).length).toBeLessThanOrEqual(12);
  });

  it("every message starts with the time now in the company's time zone and its default place", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    await setTenantSettings(db, "t1", { botName: null, retentionDays: 90, defaultModel: null, timezone: "Australia/Melbourne", location: "Melbourne", country: "Australia" });
    const q = fakeEngine({ calls: [] });
    await runTurn(deps(db, q.engine), { tenantId: "t1", chatId: "c1", definition, person, text: "when is lunch?", askConfirmation: async () => {}, receivedAt: new Date("2026-11-02T13:30:00Z") });
    expect(q.prompts[0]).toBe("[defaults: now Tuesday, 3 November 2026 at 12:30 am (Australia/Melbourne); location Melbourne, Australia]\n\nwhen is lunch?");
    expect(String(q.seen[0]!.systemPrompt)).toContain("Use them unless the person says otherwise in this chat");
  });

  it("the defaults line leaves out a place that is not set", () => {
    expect(withDefaults("hi", { timezone: "UTC", location: null, country: "Australia" }, new Date("2026-11-02T13:30:00Z"))).toBe("[defaults: now Monday, 2 November 2026 at 1:30 pm (UTC); location Australia]\n\nhi");
    expect(withDefaults("hi", { timezone: "UTC", location: null, country: null }, new Date("2026-11-02T13:30:00Z"))).toBe("[defaults: now Monday, 2 November 2026 at 1:30 pm (UTC)]\n\nhi");
    expect(withDefaults("hi", { timezone: "UTC", location: "Sydney", country: "Australia" }, new Date("2026-11-02T13:30:00Z"), { timezone: "Australia/Melbourne", location: "Melbourne, Australia" }))
      .toBe("[defaults: now Tuesday, 3 November 2026 at 12:30 am (Australia/Melbourne); location Melbourne, Australia]\n\nhi");
    expect(withDefaults("hi", { timezone: "UTC", location: "Sydney", country: "Australia" }, new Date("2026-11-02T13:30:00Z"), { timezone: null, location: null }))
      .toBe("[defaults: now Monday, 2 November 2026 at 1:30 pm (UTC); location Sydney, Australia]\n\nhi");
  });

  it("the prompt names the actions an admin set to run freely or to need a card", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    await setToolRule(db, definition.id, "mcp__connections__ssh_change", "free");
    await setToolRule(db, definition.id, "mcp__computer__bash", "confirm");
    const q = fakeEngine({ calls: [] });
    await runTurn(deps(db, q.engine), { tenantId: "t1", chatId: "c1", definition, person, text: "a", askConfirmation: async () => {} });
    const prompt = String(q.seen[0]!.systemPrompt);
    expect(prompt).toContain("never say they need confirming: ssh_change.");
    expect(prompt).toContain("need a confirmation card in the chat: bash.");
  });

  it("a named bot states its name even without a mailbox", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const q = fakeEngine({ calls: [] });
    await runTurn(deps(db, q.engine), { tenantId: "t1", chatId: "c1", definition: { ...definition, displayName: "Ada" }, person, text: "a", askConfirmation: async () => {} });
    expect(String(q.seen[0]!.systemPrompt)).toContain("Your name is Ada.");
    expect(String(q.seen[0]!.systemPrompt)).toContain("cannot send or receive email");
  });

  it("a named bot with a mailbox states its name once and its address", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    await db.insert(mailboxes).values({ definitionId: definition.id, tenantId: "t1", agent: "bb2-x", localPart: "ada", inboxId: "i1", address: "ada@mail.example.test", keyId: "k1", keyCipher: encrypt(key, "am_botkey"), status: "active" });
    const q = fakeEngine({ calls: [] });
    await runTurn({ ...deps(db, q.engine), agentmailUrl: "https://mail.example.test" }, { tenantId: "t1", chatId: "c1", definition: { ...definition, displayName: "Ada" }, person, text: "a", askConfirmation: async () => {} });
    const prompt = String(q.seen[0]!.systemPrompt);
    expect(prompt.split("Your name is Ada.").length - 1).toBe(1);
    expect(prompt).toContain("Your own email address is ada@mail.example.test.");
  });

  it("a mailbox key that cannot be decrypted means no mail, and the turn still runs", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    await db.insert(mailboxes).values({ definitionId: definition.id, tenantId: "t1", agent: "bb2-x", localPart: "ada", inboxId: "i1", address: "ada@mail.example.test", keyId: "k1", keyCipher: "garbage", status: "active" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const q = fakeEngine({ calls: [] });
    const r = await runTurn({ ...deps(db, q.engine), agentmailUrl: "https://mail.example.test" }, { tenantId: "t1", chatId: "c1", definition, person, text: "a", askConfirmation: async () => {} });
    expect(r.text).toBe("Done.");
    expect(q.seen[0]!.mcpServers).not.toHaveProperty("mail");
    expect(err).toHaveBeenCalledWith("mailbox key:", expect.any(String));
    err.mockRestore();
  });

  it("removing the mailbox leaves mail out of the next turn", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    await db.insert(mailboxes).values({ definitionId: definition.id, tenantId: "t1", agent: "bb2-x", localPart: "ada", inboxId: "i1", address: "ada@mail.example.test", keyId: "k1", keyCipher: encrypt(key, "am_botkey"), status: "active" });
    const q = fakeEngine({ calls: [] });
    const d = { ...deps(db, q.engine), agentmailUrl: "https://mail.example.test" };
    const ask = async () => {};
    await runTurn(d, { tenantId: "t1", chatId: "c1", definition, person, text: "a", askConfirmation: ask });
    await db.update(mailboxes).set({ status: "removed", keyId: null, keyCipher: null }).where(eq(mailboxes.definitionId, definition.id));
    await runTurn(d, { tenantId: "t1", chatId: "c1", definition, person, text: "b", askConfirmation: ask });
    expect(q.seen.map((o) => Object.keys(o.mcpServers).includes("mail"))).toEqual([true, false]);
  });

  it("a pending mcp connection is not attached", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    await requestConnection({ db, ssh: fakeSsh(), secretsKey: key }, "t1", {
      kind: "mcp", name: "desk", target: "https://mcp.example.test/mcp", mode: "read-only", config: { readOnlyTools: ["list_tickets"] }, definitionId: definition.id, personId: person.id,
    });
    const q = fakeEngine({ calls: [["mcp__conn-desk__list_tickets", {}]] });
    const d = deps(db, q.engine);
    const requests: ConfirmationRequest[] = [];
    await runTurn(d, { tenantId: "t1", chatId: "c1", definition, person, text: "x", askConfirmation: async (r) => void (requests.push(r), d.confirmations.resolve(r.actionId, person.id, "no")) });
    expect(Object.keys(q.seen[0]!.mcpServers)).not.toContain("conn-desk");
    expect(requests).toHaveLength(1);
  });

  it("a person definition gets m365 with only its capabilities' tools; a service definition gets none", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const q = fakeEngine({ calls: [] });
    await runTurn(deps(db, q.engine), { tenantId: "t1", chatId: "c1", definition, person, text: "x", askConfirmation: async () => {} });
    await runTurn(deps(db, q.engine), { tenantId: "t1", chatId: "c1", definition: { ...definition, identity: "person", graph: ["mail.read", "chats.read"] }, person, text: "x", askConfirmation: async () => {} });
    await runTurn(deps(db, q.engine), { tenantId: "t1", chatId: "c1", definition: { ...definition, identity: "person", graph: [] }, person, text: "x", askConfirmation: async () => {} });
    expect(q.seen[0]!.mcpServers).not.toHaveProperty("m365");
    const tools = (q.seen[1]!.mcpServers.m365 as unknown as { instance: { _registeredTools: Record<string, unknown> } }).instance._registeredTools;
    expect(Object.keys(tools).sort()).toEqual(["list_chats", "list_mail", "read_attachment", "read_chat", "read_mail", "search_mail"]);
    expect(q.seen[2]!.mcpServers).not.toHaveProperty("m365");
  });

  it("a person definition gets read-only knowledge and no connections server", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const q = fakeEngine({ calls: [] });
    await runTurn(deps(db, q.engine), { tenantId: "t1", chatId: "c1", definition: { ...definition, identity: "person", graph: ["mail.read"] }, person, text: "x", askConfirmation: async () => {} });
    expect(q.seen[0]!.mcpServers).not.toHaveProperty("connections");
    expect(Object.keys((q.seen[0]!.mcpServers.knowledge as unknown as { instance: { _registeredTools: Record<string, unknown> } }).instance._registeredTools).sort()).toEqual(["list", "read", "search"]);
  });

  it("a Graph write asks by default, runs freely when an admin set it free, and its audit row keeps recipients and subject but never the body", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const personal = { ...definition, identity: "person" as const, graph: ["mail.send" as const] };
    await setToolRule(db, definition.id, "mcp__m365__send_mail", "free");
    const input = { to: ["bea@example.test"], subject: "Quarterly figures", body: "the secret body text" };
    const q = fakeEngine({ calls: [["mcp__m365__send_mail", input], ["mcp__m365__reply_mail", { id: "m1", body: "another secret body" }]] });
    const asked: ConfirmationRequest[] = [];
    await runTurn(deps(db, q.engine, new Confirmations((fn) => (fn(), 0))), { tenantId: "t1", chatId: "c1", definition: personal, person, text: "x", askConfirmation: async (r) => void asked.push(r) });
    expect(asked.map((r) => [r.toolName, r.input])).toEqual([["mcp__m365__reply_mail", { id: "m1", body: "another secret body" }]]);
    expect(q.decisions).toEqual(["allow", "deny"]);
    const rows = (await listActions(db, { tenantId: "t1" })).filter((r) => r.kind === "tool");
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain("secret body");
    const send = rows.find((r) => r.toolName === "mcp__m365__send_mail")!;
    expect(send.toolInput).toEqual({ to: ["bea@example.test"], subject: "Quarterly figures" });
    expect(send.summary).toContain("Quarterly figures");
  });
});
