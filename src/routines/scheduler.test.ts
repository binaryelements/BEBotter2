import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookCallback, Options, PostToolUseHookInput, query } from "@anthropic-ai/claude-agent-sdk";
import { listActions } from "../audit/audit.js";
import { assignToChat, setAllowedDepartments, setChatDefinition, upsertDefinition } from "../bots/definitions.js";
import { fakeDockerClient } from "../computer/docker.js";
import { fakeSsh } from "../connections/ssh.js";
import type { Db } from "../db/client.js";
import { testDb } from "../db/test-db.js";
import { Confirmations } from "../engine/confirm.js";
import { runTurn } from "../engine/runner.js";
import type { RunTurnInput } from "../engine/runner.js";
import { createDepartment, setRole } from "../org/directory.js";
import { saveConversationReference, upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import type { AdaptiveCard } from "../teams/cards.js";
import { serialize } from "../teams/handlers.js";
import { runRoutine, startScheduler } from "./scheduler.js";
import { createRoutine } from "./store.js";

const key = Buffer.alloc(32, 9);
const later = new Date(Date.now() + 3_600_000);
const due = () => new Date(later.getTime() + 60_000);

let db: Db;
let defId: string;
let annId: string;
let stop: (() => void) | undefined;
let sent: [string, string | AdaptiveCard][];
const send = async (chatId: string, m: string | AdaptiveCard) => void sent.push([chatId, m]);

beforeEach(async () => {
  db = await testDb();
  sent = [];
  await upsertTenant(db, { id: "t1" });
  defId = (
    await upsertDefinition(db, key, "t1", {
      name: "ops", label: "Ops", persona: "p",
      mcpServers: [{ name: "tickets", transport: "http", url: "http://tickets.invalid/mcp", readOnlyTools: [] }],
    })
  ).id;
  for (const id of ["c1", "c2"]) {
    await upsertChat(db, { id, tenantId: "t1", conversationType: "groupChat" });
    await saveConversationReference(db, id, { conversation: { id } });
    await assignToChat(db, id, defId);
  }
  annId = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "a1", name: "Ann" })).id;
});
afterEach(() => stop?.());

const routine = (extra: Partial<Parameters<typeof createRoutine>[2]> = {}) =>
  createRoutine(db, "t1", { definitionId: defId, chatId: "c1", prompt: "check backups", runAt: later, createdByPersonId: annId, ...extra });

const fakeRunTurn = (fn: (turn: RunTurnInput) => Promise<string> = async () => "All good.") => {
  const turns: RunTurnInput[] = [];
  const run = vi.fn(async (turn: RunTurnInput) => {
    turns.push(turn);
    return { text: await fn(turn), costUsd: 0, sessionId: "s", changed: false };
  });
  return { run, turns };
};

describe("scheduler", () => {
  it("a due routine runs once with its prompt and posts the reply to its chat", async () => {
    await routine();
    const r = fakeRunTurn();
    stop = startScheduler({ db, runTurn: r.run, send }, 5, due);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await new Promise((res) => setTimeout(res, 50));
    expect(r.run).toHaveBeenCalledTimes(1);
    expect(r.turns[0]).toMatchObject({ text: "check backups", chatId: "c1", person: { id: annId }, routine: { grantPersonId: null } });
    expect(sent).toEqual([["c1", "**Ops**\n\nAll good."]]);
  });

  it("a quiet routine posts only what the bot posts through the post tool", async () => {
    const r = fakeRunTurn(async (turn) => {
      await turn.routine!.post("Disk 91% on db1");
      return "Checked.";
    });
    await runRoutine({ db, runTurn: r.run, send }, await routine({ quiet: true }));
    expect(sent).toEqual([["c1", "**Ops**\n\nDisk 91% on db1"]]);
  });

  it("a routine whose chat lost the bot is recorded failed and the next routine still runs", async () => {
    await routine();
    await routine({ chatId: "c2" });
    await setChatDefinition(db, "t1", "c1", null);
    const r = fakeRunTurn();
    stop = startScheduler({ db, runTurn: r.run, send }, 5, due);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]![0]).toBe("c2");
    const [row] = await listActions(db, { tenantId: "t1", chatId: "c1" });
    expect(row).toMatchObject({ kind: "message", status: "failed", summary: "Routine not run: its bot is no longer in its chat" });
  });

  it("a routine whose creator lost access to the bot is recorded failed without a run", async () => {
    const r1 = await routine();
    await setAllowedDepartments(db, "t1", defId, [(await createDepartment(db, "t1", "Sales")).id]);
    const r = fakeRunTurn();
    await runRoutine({ db, runTurn: r.run, send }, r1);
    expect(r.run).not.toHaveBeenCalled();
    expect((await listActions(db, { tenantId: "t1", chatId: "c1" }))[0]).toMatchObject({
      status: "failed", summary: "Routine not run: its creator no longer has access to this bot",
    });
  });

  it("a routine stuck in one chat does not hold back a routine in another", async () => {
    await routine();
    await routine({ chatId: "c2" });
    const r = fakeRunTurn((turn) => (turn.chatId === "c1" ? new Promise<string>(() => {}) : Promise.resolve("All good.")));
    stop = startScheduler({ db, runTurn: r.run, send }, 5, due);
    await vi.waitFor(() => expect(sent).toEqual([["c2", "**Ops**\n\nAll good."]]));
    expect(r.run).toHaveBeenCalledTimes(2);
  });

  it("a routine with no conversation reference is recorded failed without a run", async () => {
    await upsertChat(db, { id: "c3", tenantId: "t1", conversationType: "groupChat" });
    await assignToChat(db, "c3", defId);
    const r = fakeRunTurn();
    await runRoutine({ db, runTurn: r.run, send }, await routine({ chatId: "c3" }));
    expect(r.run).not.toHaveBeenCalled();
    expect((await listActions(db, { tenantId: "t1", chatId: "c3" }))[0]).toMatchObject({ status: "failed" });
  });

  it("a reply that cannot be posted is recorded failed, not thrown", async () => {
    const r = fakeRunTurn();
    const failing = async () => {
      throw new Error("No conversation reference for chat c1");
    };
    await runRoutine({ db, runTurn: r.run, send: failing }, await routine());
    expect((await listActions(db, { tenantId: "t1", chatId: "c1" }))[0]).toMatchObject({ status: "failed", summary: "Routine not run: its reply could not be posted" });
  });

  it("a routine waits for an in-flight chat turn on the same chat and bot", async () => {
    let release!: () => void;
    const chatTurn = serialize(`c1:${defId}`, () => new Promise<void>((res) => (release = res)));
    const r = fakeRunTurn();
    const run = runRoutine({ db, runTurn: r.run, send }, await routine());
    await new Promise((res) => setTimeout(res, 50));
    expect(r.run).not.toHaveBeenCalled();
    release();
    await chatTurn;
    await run;
    expect(r.run).toHaveBeenCalledTimes(1);
  });

  it("a grant whose holder is no longer an admin runs without the grant", async () => {
    await setRole(db, "t1", annId, "admin");
    const r1 = await routine({ grantPersonId: annId });
    await setRole(db, "t1", (await upsertPerson(db, { tenantId: "t1", aadObjectId: "a2", name: "Bob" })).id, "admin");
    await setRole(db, "t1", annId, "user");
    const r = fakeRunTurn();
    await runRoutine({ db, runTurn: r.run, send }, r1);
    expect(r.turns[0]!.routine!.grantPersonId).toBeNull();
  });

  it("a granted routine's write is recorded with grant authority and a quiet one still posts it", async () => {
    await setRole(db, "t1", annId, "admin");
    const r1 = await routine({ grantPersonId: annId, quiet: true });
    // drives one write tool through canUseTool and PostToolUse, the way the SDK does
    const queryFn = (({ options }: { options: Options }) =>
      (async function* () {
        const signal = new AbortController().signal;
        const input = { id: 7 };
        const d = await options.canUseTool!("mcp__tickets__close_ticket", input, { signal, toolUseID: "tu-0" } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
        if (d?.behavior === "allow") {
          const hook = options.hooks!.PostToolUse![0]!.hooks[0] as HookCallback;
          const common = { tool_name: "mcp__tickets__close_ticket", tool_input: input, tool_use_id: "tu-0", session_id: "s-1", transcript_path: "", cwd: "" };
          await hook({ ...common, hook_event_name: "PostToolUse", tool_response: "ok" } as PostToolUseHookInput, "tu-0", { signal });
        }
        yield { type: "result", subtype: "success", result: "Closed 7.", session_id: "s-1", total_cost_usd: 0.001, num_turns: 1, duration_ms: 1, is_error: false };
      })()) as unknown as typeof query;
    const runnerDeps = {
      db, queryFn, confirmations: new Confirmations(), secretsKey: key, docker: fakeDockerClient(), computerImage: "img",
      filesDir: fs.mkdtempSync(path.join(os.tmpdir(), "bebotter2-files-")), ssh: fakeSsh(), publicUrl: "https://bot.example.test",
      fetchFn: (async () => new Response("ok")) as typeof fetch,
    };
    await runRoutine({ db, runTurn: (t) => runTurn(runnerDeps, t), send }, r1);
    const tool = (await listActions(db, { tenantId: "t1" })).find((a) => a.kind === "tool")!;
    expect(tool).toMatchObject({ status: "done", authority: { type: "grant", personId: annId, routineId: r1.id } });
    expect(sent).toEqual([["c1", "**Ops**\n\nClosed 7."]]);
  });
});
