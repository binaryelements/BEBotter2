import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginAction, completeAction, listActions } from "../audit/audit.js";
import { assignToChat, ensurePersonalDefinition, setAllowedDepartments, setChatDefinition, upsertDefinition } from "../bots/definitions.js";
import { fakeDockerClient } from "../computer/docker.js";
import { fakeSsh } from "../connections/ssh.js";
import type { Db } from "../db/client.js";
import { testDb } from "../db/test-db.js";
import { Confirmations } from "../engine/confirm.js";
import type { Engine } from "../engine/engine.js";
import { runTurn } from "../engine/runner.js";
import type { RunTurnInput } from "../engine/runner.js";
import { createDepartment, setPersonalBot, setRole } from "../org/directory.js";
import { recordChatOwner, saveConversationReference, upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
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
    return { text: await fn(turn), costUsd: 0, sessionId: "s", changed: false, auditId: "none", timings: { receivedAt: new Date().toISOString(), tools: 0 } };
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

  it("a background job that fails posts a short failure instead of leaving the chat waiting", async () => {
    const r1 = await routine({ background: true });
    const r = fakeRunTurn(async () => {
      throw new Error("boom");
    });
    await runRoutine({ db, runTurn: r.run, send }, r1);
    expect(sent).toEqual([["c1", "**Ops**\n\nI couldn't finish that background job."]]);
  });

  it("records sentAt on the run's row and logs one timing line", async () => {
    await routine();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = fakeRunTurn();
    r.run.mockImplementationOnce(async (turn: RunTurnInput) => {
      const auditId = await beginAction(db, { tenantId: "t1", chatId: "c1", definitionId: defId, kind: "message", summary: "x" });
      await completeAction(db, auditId, { status: "done", timings: { receivedAt: new Date().toISOString(), tools: 0 } });
      return { text: "All good.", costUsd: 0, sessionId: "s", changed: false, auditId, timings: { receivedAt: new Date().toISOString(), tools: 0 } };
    });
    stop = startScheduler({ db, runTurn: r.run, send }, 5, due);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await vi.waitFor(() => expect(log.mock.calls.some((c) => String(c[0]).startsWith("turn c1 "))).toBe(true));
    const [row] = (await listActions(db, { tenantId: "t1" })).filter((a) => a.kind === "message");
    log.mockRestore();
    expect(row!.timings).toHaveProperty("sentAt");
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
    // drives one write tool through the app's gate and audit, the way the engine does
    const engine: Engine = {
      async run(input) {
        const decision = await input.authoriseTool("tu-0", "mcp__tickets__close_ticket", { id: 7 });
        if (decision.allow) await input.completeTool("tu-0", "done");
        return { text: "Closed 7.", messages: [...input.history, { role: "assistant", text: "Closed 7." }], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0.001 }, steps: 1, stopReason: "text" };
      },
    };
    const runnerDeps = {
      db, engine, confirmations: new Confirmations(), secretsKey: key, docker: fakeDockerClient(), computerImage: "img",
      filesDir: fs.mkdtempSync(path.join(os.tmpdir(), "bebotter2-files-")), ssh: fakeSsh(), publicUrl: "https://bot.example.test",
      fetchFn: (async () => new Response("ok")) as typeof fetch,
    };
    await runRoutine({ db, runTurn: (t) => runTurn(runnerDeps, t), send }, r1);
    const tool = (await listActions(db, { tenantId: "t1" })).find((a) => a.kind === "tool")!;
    expect(tool).toMatchObject({ status: "done", authority: { type: "grant", personId: annId, routineId: r1.id } });
    expect(sent).toEqual([["c1", "**Ops**\n\nClosed 7."]]);
  });

  describe("a personal bot's routine", () => {
    const token = "tok-ann-secret";
    async function personal() {
      await setPersonalBot(db, "t1", annId, true);
      const def = await ensurePersonalDefinition(db, "t1", "m");
      await upsertChat(db, { id: "p1", tenantId: "t1", conversationType: "personal" });
      await recordChatOwner(db, "p1", annId);
      await saveConversationReference(db, "p1", { conversation: { id: "p1" } });
      await assignToChat(db, "p1", def.id);
      return createRoutine(db, "t1", { definitionId: def.id, chatId: "p1", prompt: "summarise my inbox", runAt: later, createdByPersonId: annId });
    }

    it("runs with the owner's token, fetched per call, and never records it", async () => {
      const r1 = await personal();
      const personToken = vi.fn(async (_chatId: string) => token);
      const r = fakeRunTurn(async (turn) => ((await turn.graphToken!()) === token ? "Inbox done." : "no token"));
      await runRoutine({ db, runTurn: r.run, send, personToken }, r1);
      expect(sent).toEqual([["p1", "Inbox done."]]);
      expect(personToken).toHaveBeenCalledWith("p1");
      expect(JSON.stringify(await listActions(db, { tenantId: "t1" }))).not.toContain(token);
    });

    it("without the owner's token posts the sign-in line and stops", async () => {
      const r1 = await personal();
      const r = fakeRunTurn();
      vi.spyOn(console, "error").mockImplementation(() => {});
      await runRoutine({ db, runTurn: r.run, send, personToken: async () => undefined }, r1);
      vi.mocked(console.error).mockRestore();
      expect(r.run).not.toHaveBeenCalled();
      expect(sent).toEqual([["p1", "Sign in again to let me run this routine."]]);
      expect((await listActions(db, { tenantId: "t1", chatId: "p1" }))[0]).toMatchObject({ status: "failed" });
    });

    it("a service bot's routine never asks for a token", async () => {
      const personToken = vi.fn(async () => token);
      const r = fakeRunTurn();
      await runRoutine({ db, runTurn: r.run, send, personToken }, await routine());
      expect(personToken).not.toHaveBeenCalled();
      expect(r.turns[0]!.graphToken).toBeUndefined();
    });
  });
});
