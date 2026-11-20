import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { listActions } from "../audit/audit.js";
import { assignToChat, upsertDefinition } from "../bots/definitions.js";
import type { BotDefinition, Person, Workflow, WorkflowRun } from "../db/schema.js";
import { fakeDockerClient } from "../computer/docker.js";
import { fakeSsh } from "../connections/ssh.js";
import type { Db } from "../db/client.js";
import { testDb } from "../db/test-db.js";
import { workflowPending, workflowRuns } from "../db/schema.js";
import { Confirmations } from "../engine/confirm.js";
import type { Engine } from "../engine/engine.js";
import { runTurn } from "../engine/runner.js";
import type { RunTurnInput } from "../engine/runner.js";
import { setRole } from "../org/directory.js";
import { saveConversationReference, upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import type { AdaptiveCard } from "../teams/cards.js";
import { clickApproval, inputHash, latestDecision, resolveApproval } from "./approvals.js";
import { tickWorkflows } from "./engine.js";
import type { WorkflowGraph } from "./graph.js";
import { deliverEvent, startRun } from "./runs.js";
import { createWorkflow, publish, saveDraft } from "./store.js";

const key = Buffer.alloc(32, 9);
const WRITE = "mcp__tickets__close_ticket";
const HELD = "Sent for approval. Don't retry it. End the step now without calling report_result.";
const b = { x: 0, y: 0 };
const graph: WorkflowGraph = {
  nodes: [
    { ...b, id: "t", label: "Start", type: "trigger", trigger: "manual" },
    { ...b, id: "a", label: "Close", type: "ai", instruction: "Close the ticket", success: "closed", results: [{ name: "done", meaning: "closed" }] },
    { ...b, id: "e", label: "Fin", type: "end", outcome: "ok" },
  ],
  edges: [
    { from: "t", exit: "next", to: "a" },
    { from: "a", exit: "done", to: "e" },
    { from: "a", exit: "new_message", to: "a" },
  ],
  holidays: [],
};
const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), "bebotter2-approvals-"));

describe("workflow approvals", () => {
  let db: Db;
  let wf: Workflow;
  let definition: BotDefinition;
  let annP: Person;
  let ann: string;
  let bob: string;
  let sent: (string | AdaptiveCard)[];
  let turns: RunTurnInput[];
  let messages: (string | undefined)[];
  let confirmations: Confirmations;

  /** A step whose turn makes `calls` through the real runner, then reports `done` unless told not to. */
  const step = (calls: [string, Record<string, unknown>][], reports = false) => {
    const engine: Engine = {
      async run(input) {
        for (const [i, [name, args]] of calls.entries()) {
          const d = await input.authoriseTool(`tu-${i}`, name, args);
          if (d.allow) await input.completeTool(`tu-${i}`, "done");
          else messages.push(d.message);
        }
        return { text: "x", messages: [...input.history], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, steps: 1, stopReason: "text" };
      },
    };
    const runner = { db, engine, confirmations, secretsKey: key, docker: fakeDockerClient(), computerImage: "img", filesDir, ssh: fakeSsh(), publicUrl: "https://bot.example.test", fetchFn: (async () => new Response("ok")) as typeof fetch };
    return tickWorkflows({
      db,
      send: async (_c, m) => void sent.push(m),
      runTurn: async (turn) => {
        turns.push(turn);
        const r = await runTurn(runner, turn);
        if (reports) await db.update(workflowRuns).set({ reportedResult: { result: "done", reason: "closed" } }).where(eq(workflowRuns.id, turn.workflow!.runId));
        return r;
      },
    });
  };
  const reload = async (r: WorkflowRun) => (await db.select().from(workflowRuns).where(eq(workflowRuns.id, r.id)))[0]!;
  const pending = async (runId: string) => db.select().from(workflowPending).where(eq(workflowPending.runId, runId));
  const start = () => startRun(db, wf, { title: "T1", keys: { threadIds: [], emails: [], domain: null }, event: { type: "manual", fields: {} } });
  const held = async () => {
    const r = await start();
    await step([[WRITE, { id: 7 }]]);
    return { r, id: (await pending(r.id))[0]!.id };
  };

  beforeEach(async () => {
    db = await testDb();
    sent = [];
    turns = [];
    messages = [];
    confirmations = new Confirmations();
    await upsertTenant(db, { id: "t1" });
    await upsertChat(db, { id: "c1", tenantId: "t1", conversationType: "groupChat" });
    await saveConversationReference(db, "c1", { conversation: { id: "c1" } });
    definition = await upsertDefinition(db, key, "t1", { name: "ops", label: "Ops", persona: "p", mcpServers: [{ name: "tickets", transport: "http", url: "http://tickets.invalid/mcp", readOnlyTools: [] }] });
    await assignToChat(db, "c1", definition.id);
    annP = await upsertPerson(db, { tenantId: "t1", aadObjectId: "a1", name: "Ann" });
    ann = annP.id;
    bob = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "b1", name: "Bob" })).id;
    wf = await createWorkflow(db, "t1", { definitionId: definition.id, name: "wf", chatId: "c1", runAsPersonId: ann });
    await saveDraft(db, "t1", wf.id, graph);
    await publish(db, "t1", wf.id, ann, {});
  });

  it("a workflow write raises a stored card, not a live wait", async () => {
    const { r, id } = await held();
    expect(await pending(r.id)).toMatchObject([{ id, nodeId: "a", kind: "approval", toolName: WRITE, input: { id: 7 }, inputHash: inputHash(WRITE, { id: 7 }), status: "pending" }]);
    expect(messages).toEqual([HELD]);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain(id); // the card's actionId is the stored row
    expect(await reload(r)).toMatchObject({ nodeId: "a", status: "waiting" });
    const row = (await listActions(db, { tenantId: "t1" })).find((a) => a.toolName === WRITE)!;
    expect(row.status).toBe("pending"); // held: the in-flight marker wroteSince relies on
  });

  it("approval re-runs the step with a one-time allow", async () => {
    const { r, id } = await held();
    expect(await clickApproval(db, id, ann, "yes")).toBe("confirmed");
    expect(await reload(r)).toMatchObject({ status: "ready" });
    messages = [];
    await step([[WRITE, { id: 7 }], [WRITE, { id: 7 }]]);
    expect(turns[1]!.text).toContain("Approved by Ann: make exactly the call you asked for, then report.");
    expect(turns[1]!.workflow!.approved).toMatchObject({ pendingId: id, toolName: WRITE, personId: ann });
    expect(messages).toEqual([HELD]); // the first call ran; the identical second one is held again
    const rows = (await listActions(db, { tenantId: "t1" })).filter((a) => a.toolName === WRITE && a.status === "done");
    expect(rows.map((a) => a.authority)).toEqual([{ type: "confirmation", personId: ann }]);
    expect(await latestDecision(db, r.id, "a")).toEqual({}); // used once
  });

  it("a different input is held again after an approval", async () => {
    const { r, id } = await held();
    await clickApproval(db, id, ann, "yes");
    messages = [];
    await step([[WRITE, { id: 8 }], [WRITE, { id: 9 }]]);
    expect(messages).toEqual([HELD, "Waiting for approval of an earlier change. End the step now."]);
    expect((await pending(r.id)).filter((p) => p.status === "pending").map((p) => p.input)).toEqual([{ id: 8 }]);
    expect(await reload(r)).toMatchObject({ status: "waiting" });
  });

  it("a click after cancel runs nothing", async () => {
    const { r, id } = await held();
    await deliverEvent(db, r.id, { type: "email", from: "c@acme.com", subject: "wait", messageId: "m2", threadId: null }, async () => {});
    expect((await pending(r.id))[0]!.status).toBe("cancelled");
    expect(await clickApproval(db, id, ann, "yes")).toBe("unknown");
    await step([]);
    expect(turns.at(-1)!.workflow!.approved).toBeUndefined();
  });

  it("decline re-runs with the declined line, once", async () => {
    const { r, id } = await held();
    expect(await clickApproval(db, id, ann, "no")).toBe("denied");
    expect(await reload(r)).toMatchObject({ status: "ready" });
    await step([]);
    expect(turns[1]!.text).toContain("Declined by Ann.");
    expect(turns[1]!.workflow!.approved).toBeUndefined();
    expect(await reload(r)).toMatchObject({ status: "ready", attempts: 1 }); // no report, nothing written: retried
    await step([]);
    expect(turns[2]!.text).not.toContain("Declined");
  });

  it("a person not allowed to confirm gets not_allowed", async () => {
    const { r, id } = await held();
    expect(await clickApproval(db, id, bob, "yes")).toBe("not_allowed");
    expect((await pending(r.id))[0]!.status).toBe("pending");
    expect(await resolveApproval(db, id, ann, "yes", async () => false)).toBe("not_allowed");
    expect(await clickApproval(db, "nope", ann, "yes")).toBe("unknown");
  });

  it("an approve-class tool in a workflow turn still asks in memory", async () => {
    const r = await start();
    await setRole(db, "t1", ann, "admin"); // only an admin may answer a connection approval
    let asked = 0;
    const engine: Engine = {
      async run(input) {
        const d = await input.authoriseTool("tu-0", "mcp__connections__approve", { id: "x" });
        if (!d.allow) messages.push(d.message);
        return { text: "x", messages: [...input.history], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, steps: 1, stopReason: "text" };
      },
    };
    const runner = { db, engine, confirmations, secretsKey: key, docker: fakeDockerClient(), computerImage: "img", filesDir, ssh: fakeSsh(), publicUrl: "https://bot.example.test", fetchFn: (async () => new Response("ok")) as typeof fetch };
    const [claimed] = await db.update(workflowRuns).set({ status: "running", stepStartedAt: new Date() }).where(eq(workflowRuns.id, r.id)).returning();
    await runTurn(runner, {
      tenantId: "t1", chatId: "c1", definition, person: annP, text: "x",
      askConfirmation: async (req) => void (asked++, await confirmations.resolve(req.actionId, ann, "no")),
      routine: { id: `wf:${r.id}`, grantPersonId: null, post: async () => {}, background: true },
      workflow: { runId: r.id, nodeId: "a", stepStartedAt: claimed!.stepStartedAt!.toISOString(), results: ["done"], saves: [] },
    });
    expect(asked).toBe(1);
    expect(messages).toEqual(["Not done: declined in the chat."]);
    expect(await pending(r.id)).toEqual([]);
  });
});
