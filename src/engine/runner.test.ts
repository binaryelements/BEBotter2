import { afterEach, describe, expect, it, vi } from "vitest";
import type { HookCallback, Options, PostToolUseHookInput, query } from "@anthropic-ai/claude-agent-sdk";
import { listActions } from "../audit/audit.js";
import { upsertDefinition } from "../bots/definitions.js";
import type { BotDefinitionInput } from "../bots/definitions.js";
import { fakeDockerClient } from "../computer/docker.js";
import type { Db } from "../db/client.js";
import { sessions } from "../db/schema.js";
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
function fakeQuery() {
  const seen: Options[] = [];
  const fn = (({ options }: { prompt: string; options: Options }) => {
    seen.push(options);
    return (async function* () {
      const signal = new AbortController().signal;
      for (const [name, input] of calls) {
        const r = await options.canUseTool!(name, input, { signal, toolUseID: "tu-1" } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
        if (r?.behavior !== "allow") continue;
        const hook = options.hooks!.PostToolUse![0]!.hooks[0] as HookCallback;
        const hookInput = { hook_event_name: "PostToolUse", tool_name: name, tool_input: input, tool_response: "ok", tool_use_id: "tu-1", session_id: "s-1", transcript_path: "", cwd: "" } as PostToolUseHookInput;
        await hook(hookInput, "tu-1", { signal });
      }
      yield { type: "result", subtype: "success", result: "Done.", session_id: "s-1", total_cost_usd: 0.001, num_turns: 2, duration_ms: 10, is_error: false };
    })();
  }) as unknown as typeof query;
  return { fn, seen };
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

function deps(db: Db, queryFn: typeof query, confirmations = new Confirmations()) {
  const docker = fakeDockerClient();
  return { db, queryFn, confirmations, secretsKey: key, docker, computerImage: "img" };
}

afterEach(() => vi.useRealTimers());

describe("runTurn", () => {
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

    expect(result).toEqual({ text: "Done.", costUsd: 0.001, sessionId: "s-1" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ label: "Ops", summary: 'close_ticket {"id":7}' });
    expect(Object.keys(q.seen[0]!.mcpServers!).sort()).toEqual(["computer", "tickets"]);
    expect(q.seen[0]!.allowedTools).toEqual([]);

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
    expect((await db.select().from(sessions))[0]).toMatchObject({ chatId: "c1", definitionId: definition.id, sdkSessionId: "s-1" });
    expect(q.seen[0]!.resume).toBeUndefined();
    await runTurn(d, turn);
    expect(q.seen[1]!.resume).toBe("s-1");
    expect(await db.select().from(sessions)).toHaveLength(1);
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
    expect(result).toEqual({ text: "I couldn't finish that.", costUsd: 0.5, sessionId: "s-2" });
    const [row] = await listActions(db, { tenantId: "t1" });
    expect(row).toMatchObject({ kind: "message", status: "failed" });
  });
});
