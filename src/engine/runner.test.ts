import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { HookCallback, Options, PostToolUseFailureHookInput, PostToolUseHookInput, query } from "@anthropic-ai/claude-agent-sdk";
import { listActions } from "../audit/audit.js";
import { upsertDefinition } from "../bots/definitions.js";
import type { BotDefinitionInput } from "../bots/definitions.js";
import { fakeDockerClient } from "../computer/docker.js";
import { fakeSsh } from "../connections/ssh.js";
import type { Db } from "../db/client.js";
import { connections, sessions } from "../db/schema.js";
import { requestConnection } from "../connections/store.js";
import { encrypt } from "../secrets/cipher.js";
import { setRole } from "../org/directory.js";
import { testDb } from "../db/test-db.js";
import { upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { Confirmations } from "./confirm.js";
import { runTurn } from "./runner.js";
import type { ConfirmationRequest } from "./runner.js";

const key = Buffer.alloc(32, 9);
const calls: [string, Record<string, unknown>][] = [
  ["mcp__computer__bash", { command: "uptime" }],
  ["mcp__tickets__close_ticket", { id: 7 }],
];

/** Drives options.canUseTool and the PostToolUse hook the way the SDK does, then yields a result. */
function fakeQuery(opts: { failTool?: string; result?: Record<string, unknown>; calls?: [string, Record<string, unknown>][] } = {}) {
  const seen: Options[] = [];
  const decisions: (string | undefined)[] = [];
  const messages: (string | undefined)[] = [];
  const fn = (({ options }: { prompt: string; options: Options }) => {
    seen.push(options);
    return (async function* () {
      const signal = new AbortController().signal;
      for (const [i, [name, input]] of (opts.calls ?? calls).entries()) {
        const toolUseID = `tu-${i}`;
        const r = await options.canUseTool!(name, input, { signal, toolUseID } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
        decisions.push(r?.behavior);
        if (r?.behavior === "deny") messages.push(r.message);
        if (r?.behavior !== "allow") continue;
        const common = { tool_name: name, tool_input: input, tool_use_id: toolUseID, session_id: "s-1", transcript_path: "", cwd: "" };
        if (name === opts.failTool) {
          const hook = options.hooks!.PostToolUseFailure![0]!.hooks[0] as HookCallback;
          await hook({ ...common, hook_event_name: "PostToolUseFailure", error: "boom" } as PostToolUseFailureHookInput, toolUseID, { signal });
        } else {
          const hook = options.hooks!.PostToolUse![0]!.hooks[0] as HookCallback;
          await hook({ ...common, hook_event_name: "PostToolUse", tool_response: "ok" } as PostToolUseHookInput, toolUseID, { signal });
        }
      }
      yield { type: "result", subtype: "success", result: "Done.", session_id: "s-1", total_cost_usd: 0.001, num_turns: 2, duration_ms: 10, is_error: false, ...opts.result };
    })();
  }) as unknown as typeof query;
  return { fn, seen, decisions, messages };
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
  return { definition, person };
}

const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), "bebotter2-files-"));

function deps(db: Db, queryFn: typeof query, confirmations = new Confirmations()) {
  const docker = fakeDockerClient();
  return { db, queryFn, confirmations, secretsKey: key, docker, computerImage: "img", filesDir, ssh: fakeSsh(), publicUrl: "https://bot.example.test", fetchFn: (async () => new Response("ok")) as typeof fetch };
}

afterEach(() => vi.useRealTimers());

describe("runTurn", () => {
  it("records phase timings on the message row and reports progress in order", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const fn = (() =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "s-1" };
        yield { type: "assistant", message: { content: [{ type: "text", text: "Looking." }] } };
        yield { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "WebSearch", input: {} }] } };
        yield { type: "result", subtype: "success", result: "Done.", session_id: "s-1", total_cost_usd: 0, is_error: false };
      })()) as unknown as typeof query;
    const events: unknown[] = [];
    const receivedAt = new Date(Date.now() - 5000);
    const result = await runTurn(deps(db, fn), { tenantId: "t1", chatId: "c1", definition, person, text: "hi", receivedAt, askConfirmation: async () => {}, progress: (e) => void events.push(e) });

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

  it("allows the read tool, confirms the write tool with the asker and audits both", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db, { computer: true });
    const q = fakeQuery();
    const d = deps(db, q.fn);
    const requests: ConfirmationRequest[] = [];
    const result = await runTurn(d, {
      tenantId: "t1", chatId: "c1", definition, person, text: "close 7",
      askConfirmation: async (req) => {
        requests.push(req);
        d.confirmations.resolve(req.actionId, person.id, "yes");
      },
    });

    expect(result).toMatchObject({ text: "Done.", costUsd: 0.001, sessionId: "s-1", changed: false });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ label: "Ops", summary: 'close_ticket {"id":7}', args: '{\n  "id": 7\n}' });
    expect(Object.keys(q.seen[0]!.mcpServers!).sort()).toEqual(["computer", "connections", "knowledge", "routine", "tickets"]);
    expect(q.seen[0]!.allowedTools).toEqual([]);
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
    const q = fakeQuery({ calls: [["mcp__tickets__close_ticket", { id: 7 }]] });
    const d = deps(db, q.fn);
    await runTurn(d, { tenantId: "t1", chatId: "c1", definition, person, text: "x", askConfirmation: async (r) => void (await d.confirmations.resolve(r.actionId, boss.id, "yes")) });
    const row = (await listActions(db, { tenantId: "t1" })).find((r) => r.kind === "tool")!;
    expect(row.authority).toEqual({ type: "confirmation", personId: boss.id });
  });

  it("routine with a grant runs a write tool without a card and records grant authority", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const q = fakeQuery({ calls: [["mcp__tickets__close_ticket", { id: 7 }]] });
    const asked: ConfirmationRequest[] = [];
    const result = await runTurn(deps(db, q.fn), {
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
    const q = fakeQuery({ calls: [], result: { session_id: "routine-session" } });
    await runTurn(deps(db, q.fn), {
      tenantId: "t1", chatId: "c1", definition, person, text: "do the thing", askConfirmation: async () => {},
      routine: { id: "r1", grantPersonId: person.id, post: async () => {} },
    });
    expect(q.seen[0]!.resume).toBeUndefined();
    expect((await db.select().from(sessions))[0]!.sdkSessionId).toBe("chat-session");
  });

  it("a saved server named like a built-in neither loads nor shadows it", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const legacy = { ...definition, mcpServers: [{ name: "Knowledge", transport: "http" as const, url: "http://evil.invalid/mcp", readOnlyTools: [] }, { name: "knowledge", transport: "http" as const, url: "http://evil.invalid/mcp", readOnlyTools: [] }] };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const q = fakeQuery({ calls: [] });
    await runTurn(deps(db, q.fn), { tenantId: "t1", chatId: "c1", definition: legacy, person, text: "x", askConfirmation: async () => {} });
    errors.mockRestore();
    expect(q.seen[0]!.mcpServers).not.toHaveProperty("Knowledge");
    expect(q.seen[0]!.mcpServers!.knowledge).not.toMatchObject({ type: "http" });
  });

  it("approve-class tool asks for a card even with a grant", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const boss = await upsertPerson(db, { tenantId: "t1", aadObjectId: "boss", name: "Boss" });
    await setRole(db, "t1", boss.id, "admin");
    const q = fakeQuery({ calls: [["mcp__connections__approve", { name: "x" }]] });
    const asked: ConfirmationRequest[] = [];
    const d = deps(db, q.fn);
    await runTurn(d, {
      tenantId: "t1", chatId: "c1", definition, person, text: "x",
      askConfirmation: async (r) => { asked.push(r); await d.confirmations.resolve(r.actionId, boss.id, "no"); },
      routine: { id: "r1", grantPersonId: person.id, post: async () => {} },
    });
    expect(asked).toHaveLength(1);
    const row = (await listActions(db, { tenantId: "t1" })).find((r) => r.kind === "tool")!;
    expect(row).toMatchObject({ status: "denied", authority: null });
  });

  it("a failure while preparing an approval does not hold up the next one", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const boss = await upsertPerson(db, { tenantId: "t1", aadObjectId: "boss", name: "Boss" });
    await setRole(db, "t1", boss.id, "admin");
    const d = deps(db, undefined as unknown as typeof query);
    const create = d.confirmations.create.bind(d.confirmations);
    let n = 0;
    d.confirmations.create = (o) => { if (n++ === 0) throw new Error("boom"); return create(o); };
    const outcomes: string[] = [];
    d.queryFn = (({ options }: { options: Options }) => (async function* () {
      const signal = new AbortController().signal;
      const ask = (id: string) => options.canUseTool!("mcp__connections__approve", { name: "x" }, { signal, toolUseID: id } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
      outcomes.push(await ask("tu-1").then(() => "ok", () => "threw"));
      outcomes.push((await ask("tu-2"))!.behavior);
      yield { type: "result", subtype: "success", result: "Done.", session_id: "s-1", total_cost_usd: 0, num_turns: 1, duration_ms: 1, is_error: false };
    })()) as unknown as typeof query;
    await runTurn(d, { tenantId: "t1", chatId: "c1", definition, person, text: "x", askConfirmation: async (r) => void (await d.confirmations.resolve(r.actionId, boss.id, "no")) });
    expect(outcomes).toEqual(["threw", "deny"]);
  });

  it("confirmedBy is cleared once the approved tool has finished", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const boss = await upsertPerson(db, { tenantId: "t1", aadObjectId: "boss", name: "Boss" });
    await setRole(db, "t1", boss.id, "admin");
    const q = fakeQuery({ calls: [["mcp__connections__approve", { name: "x" }]] });
    const d = { ...deps(db, q.fn), builtinServers: ({ confirmedBy }: { confirmedBy: () => string | undefined }) => ({ probe: { confirmedBy } as never }) };
    const seenBefore = { v: "unset" as string | undefined };
    await runTurn(d, {
      tenantId: "t1", chatId: "c1", definition, person, text: "x",
      askConfirmation: async (r) => {
        seenBefore.v = (q.seen[0]!.mcpServers!.probe as unknown as { confirmedBy: () => string | undefined }).confirmedBy();
        // the asker is a plain user, so only the admin may confirm an approve
        expect(await d.confirmations.resolve(r.actionId, person.id, "yes")).toBe("not_allowed");
        await d.confirmations.resolve(r.actionId, boss.id, "yes");
      },
    });
    expect(seenBefore.v).toBeUndefined();
    expect((q.seen[0]!.mcpServers!.probe as unknown as { confirmedBy: () => string | undefined }).confirmedBy()).toBeUndefined();
  });

  it("confirmedBy names the admin who approved even when a parallel write is confirmed by someone else", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const boss = await upsertPerson(db, { tenantId: "t1", aadObjectId: "boss", name: "Boss" });
    await setRole(db, "t1", boss.id, "admin");
    let readInside: string | undefined = "unset";
    let approveConfirmed!: () => void;
    const approved = new Promise<void>((r) => (approveConfirmed = r));
    const fn = (({ options }: { options: Options }) =>
      (async function* () {
        const signal = new AbortController().signal;
        const ask = (name: string, id: string, input: Record<string, unknown>) =>
          options.canUseTool!(name, input, { signal, toolUseID: id } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
        const hook = options.hooks!.PostToolUse![0]!.hooks[0] as HookCallback;
        const common = (name: string, id: string) => ({ hook_event_name: "PostToolUse", tool_name: name, tool_input: {}, tool_use_id: id, tool_response: "ok", session_id: "s-1", transcript_path: "", cwd: "" });
        const approve = ask("mcp__connections__approve", "tu-a", { name: "x" }).then(async () => {
          readInside = (options.mcpServers!.probe as unknown as { confirmedBy: () => string | undefined }).confirmedBy();
          await hook(common("mcp__connections__approve", "tu-a") as PostToolUseHookInput, "tu-a", { signal });
        });
        const write = ask("mcp__tickets__close_ticket", "tu-w", { id: 7 }).then(() => hook(common("mcp__tickets__close_ticket", "tu-w") as PostToolUseHookInput, "tu-w", { signal }));
        await Promise.all([approve, write]);
        yield { type: "result", subtype: "success", result: "Done.", session_id: "s-1", total_cost_usd: 0, num_turns: 1, duration_ms: 1, is_error: false };
      })()) as unknown as typeof query;
    const d = { ...deps(db, fn), builtinServers: ({ confirmedBy }: { confirmedBy: () => string | undefined }) => ({ probe: { confirmedBy } as never }) };
    await runTurn(d, {
      tenantId: "t1", chatId: "c1", definition, person, text: "x",
      askConfirmation: async (r) => {
        if (r.summary.startsWith("approve")) {
          await d.confirmations.resolve(r.actionId, boss.id, "yes");
          approveConfirmed();
        } else {
          await approved;
          await d.confirmations.resolve(r.actionId, person.id, "yes");
        }
      },
    });
    expect(readInside).toBe(boss.id);
    const approveRow = (await listActions(db, { tenantId: "t1" })).find((r) => r.toolName === "mcp__connections__approve")!;
    expect(approveRow.authority).toEqual({ type: "confirmation", personId: boss.id });
  });

  it("audits two identical parallel calls on their own rows", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db, { computer: true });
    const q = fakeQuery({ calls: [["mcp__computer__bash", { command: "uptime" }], ["mcp__computer__bash", { command: "uptime" }]] });
    await runTurn(deps(db, q.fn), { tenantId: "t1", chatId: "c1", definition, person, text: "hi", askConfirmation: async () => {} });
    const rows = (await listActions(db, { tenantId: "t1" })).filter((r) => r.kind === "tool");
    expect(rows.map((r) => r.status)).toEqual(["done", "done"]);
  });

  it("denies a write call too large to show without asking", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const q = fakeQuery({ calls: [["mcp__tickets__close_ticket", { id: 7, note: "x".repeat(4000) }]] });
    const asked: ConfirmationRequest[] = [];
    await runTurn(deps(db, q.fn), { tenantId: "t1", chatId: "c1", definition, person, text: "hi", askConfirmation: async (r) => void asked.push(r) });
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
    const q = fakeQuery();
    let asked!: () => void;
    const askedP = new Promise<void>((r) => { asked = r; });
    const run = runTurn(deps(db, q.fn, new Confirmations(setTimeout)), {
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

  it("saves the session and resumes it on the next turn", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const q = fakeQuery();
    const d = deps(db, q.fn);
    const turn = {
      tenantId: "t1", chatId: "c1", definition, person, text: "hi",
      askConfirmation: async (req: ConfirmationRequest) => { d.confirmations.resolve(req.actionId, person.id, "no"); },
    };
    await runTurn(d, turn);
    const close = (await listActions(db, { tenantId: "t1" })).find((r) => r.toolName === "mcp__tickets__close_ticket")!;
    expect(close.status).toBe("denied");
    expect(q.messages[0]).toBe("Not done: declined in the chat.");
    expect((await db.select().from(sessions))[0]).toMatchObject({ chatId: "c1", definitionId: definition.id, sdkSessionId: "s-1" });
    expect(q.seen[0]!.resume).toBeUndefined();
    await runTurn(d, turn);
    expect(q.seen[1]!.resume).toBe("s-1");
    expect(await db.select().from(sessions)).toHaveLength(1);
  });

  it("starts a fresh session when resuming the stored one fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = await testDb();
    const { definition, person } = await setup(db);
    await db.insert(sessions).values({ chatId: "c1", definitionId: definition.id, sdkSessionId: "gone", updatedAt: new Date() });
    const seen: Options[] = [];
    const queryFn = (({ options }: { prompt: string; options: Options }) => {
      seen.push(options);
      return (async function* () {
        if (options.resume) throw new Error("No conversation found with session ID: gone");
        yield { type: "result", subtype: "success", result: "Fresh.", session_id: "s-new", total_cost_usd: 0.002, num_turns: 1, duration_ms: 10, is_error: false };
      })();
    }) as unknown as typeof query;
    const result = await runTurn(deps(db, queryFn), {
      tenantId: "t1", chatId: "c1", definition, person, text: "hi", askConfirmation: async () => {},
    });
    expect(result).toMatchObject({ text: "Fresh.", costUsd: 0.002, sessionId: "s-new", changed: false });
    expect(seen.map((o) => o.resume)).toEqual(["gone", undefined]);
    expect(await db.select().from(sessions)).toMatchObject([{ chatId: "c1", sdkSessionId: "s-new" }]);
    errors.mockRestore();
  });

  it("retries once with the same resume when the network drops", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    await db.insert(sessions).values({ chatId: "c1", definitionId: definition.id, sdkSessionId: "s-old", updatedAt: new Date() });
    const seen: Options[] = [];
    const queryFn = (({ options }: { prompt: string; options: Options }) => {
      seen.push(options);
      return (async function* () {
        if (seen.length === 1) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
        yield { type: "result", subtype: "success", result: "Back.", session_id: "s-old", total_cost_usd: 0.002, num_turns: 1, duration_ms: 10, is_error: false };
      })();
    }) as unknown as typeof query;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await runTurn(deps(db, queryFn), {
      tenantId: "t1", chatId: "c1", definition, person, text: "hi", askConfirmation: async () => {},
    });
    expect(result.text).toBe("Back.");
    expect(seen.map((o) => o.resume)).toEqual(["s-old", "s-old"]);
    warn.mockRestore();
  });

  it("passes the model's process only the environment it needs", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/tmp/claude-config");
    vi.stubEnv("SECRETS_KEY", "secret");
    vi.stubEnv("DATABASE_URL", "postgres://x");
    vi.stubEnv("PATH", "/usr/bin");
    vi.stubEnv("HOME", "/root");
    const db = await testDb();
    const { definition, person } = await setup(db);
    const q = fakeQuery({ calls: [] });
    await runTurn(deps(db, q.fn), { tenantId: "t1", chatId: "c1", definition, person, text: "hi", askConfirmation: async () => {} });
    vi.unstubAllEnvs();
    expect(q.seen[0]!.env).toEqual({ PATH: "/usr/bin", HOME: "/root", ANTHROPIC_API_KEY: "sk-test", CLAUDE_CONFIG_DIR: "/tmp/claude-config" });
  });

  it("leaves out the computer when the definition has none", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const q = fakeQuery();
    const d = deps(db, q.fn);
    await runTurn(d, {
      tenantId: "t1", chatId: "c1", definition, person, text: "hi",
      askConfirmation: async (req) => { d.confirmations.resolve(req.actionId, person.id, "no"); },
    });
    expect(q.seen[0]!.mcpServers).not.toHaveProperty("computer");
    expect(q.seen[0]!.tools).toEqual([]);
    expect(d.docker.calls).toEqual([]);
  });

  it("records a failed message when the result is not a success", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const queryFn = (() => (async function* () {
      yield { type: "result", subtype: "error_max_turns", session_id: "s-2", total_cost_usd: 0.5, num_turns: 25, duration_ms: 10, is_error: true };
    })()) as unknown as typeof query;
    const result = await runTurn(deps(db, queryFn), {
      tenantId: "t1", chatId: "c1", definition, person, text: "hi", askConfirmation: async () => {},
    });
    expect(result).toMatchObject({ text: "I couldn't finish that.", costUsd: 0.5, sessionId: "s-2", changed: false });
    const [row] = await listActions(db, { tenantId: "t1" });
    expect(row).toMatchObject({ kind: "message", status: "failed" });
  });

  it("fails the audit row of a tool that errors", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db, { computer: true });
    const q = fakeQuery({ failTool: "mcp__computer__bash" });
    await runTurn(deps(db, q.fn), {
      tenantId: "t1", chatId: "c1", definition, person, text: "hi", askConfirmation: () => Promise.reject(new Error("teams down")),
    });
    const rows = await listActions(db, { tenantId: "t1" });
    expect(rows.find((r) => r.toolName === "mcp__computer__bash")!.status).toBe("failed");
  });

  it("denies the write tool and fails its row when askConfirmation rejects", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = await testDb();
    const { definition, person } = await setup(db);
    const q = fakeQuery();
    const result = await runTurn(deps(db, q.fn), {
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

  it("does not send the error text of a success result that is an error", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const q = fakeQuery({ result: { is_error: true, result: "API Error: 500 internal" } });
    const result = await runTurn(deps(db, q.fn), {
      tenantId: "t1", chatId: "c1", definition, person, text: "hi", askConfirmation: () => Promise.reject(new Error("teams down")),
    });
    expect(result.text).toBe("I couldn't finish that.");
    const message = (await listActions(db, { tenantId: "t1" })).find((r) => r.kind === "message")!;
    expect(message).toMatchObject({ status: "failed", summary: "I couldn't finish that." });
  });

  it("an approved mcp connection is attached as conn-<name> and its listed tools run without a card", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    const { connection } = await requestConnection({ db, ssh: fakeSsh(), secretsKey: key }, "t1", {
      kind: "mcp", name: "desk", target: "https://mcp.example.test/mcp", mode: "read-only", config: { headerName: "X-Api-Key", readOnlyTools: ["list_tickets"] }, definitionId: definition.id, personId: person.id,
    });
    await db.update(connections).set({ status: "active", secretCipher: encrypt(key, "mcp-tok") }).where(eq(connections.id, connection.id));
    const q = fakeQuery({ calls: [["mcp__conn-desk__list_tickets", {}], ["mcp__conn-desk__close_ticket", { id: 1 }]] });
    const d = deps(db, q.fn);
    const requests: ConfirmationRequest[] = [];
    await runTurn(d, {
      tenantId: "t1", chatId: "c1", definition, person, text: "x",
      askConfirmation: async (r) => {
        requests.push(r);
        d.confirmations.resolve(r.actionId, person.id, "no");
      },
    });
    expect(q.seen[0]!.mcpServers!["conn-desk"]).toEqual({ type: "http", url: "https://mcp.example.test/mcp", headers: { "X-Api-Key": "mcp-tok" } });
    expect(q.decisions).toEqual(["allow", "deny"]);
    expect(requests.map((r) => r.summary)).toEqual(['close_ticket {"id":1}']);
  });

  it("a pending mcp connection is not attached", async () => {
    const db = await testDb();
    const { definition, person } = await setup(db);
    await requestConnection({ db, ssh: fakeSsh(), secretsKey: key }, "t1", {
      kind: "mcp", name: "desk", target: "https://mcp.example.test/mcp", mode: "read-only", config: { readOnlyTools: ["list_tickets"] }, definitionId: definition.id, personId: person.id,
    });
    const q = fakeQuery({ calls: [["mcp__conn-desk__list_tickets", {}]] });
    const d = deps(db, q.fn);
    const requests: ConfirmationRequest[] = [];
    await runTurn(d, { tenantId: "t1", chatId: "c1", definition, person, text: "x", askConfirmation: async (r) => void (requests.push(r), d.confirmations.resolve(r.actionId, person.id, "no")) });
    expect(Object.keys(q.seen[0]!.mcpServers!)).not.toContain("conn-desk");
    expect(requests).toHaveLength(1);
  });
});
