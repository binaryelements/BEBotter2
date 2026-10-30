import { describe, expect, it, vi } from "vitest";
import { assignToChat, upsertDefinition } from "../bots/definitions.js";
import { testDb } from "../db/test-db.js";
import { Confirmations } from "../engine/confirm.js";
import type { RunTurnInput } from "../engine/runner.js";
import { upsertChat, upsertTenant } from "../org/org.js";
import { clickPayload, handleConfirmClick, handleMessage, membersAddedGreeting } from "./handlers.js";
import type { IncomingMessage } from "./handlers.js";

const msg = (conversationType: string): IncomingMessage => ({
  tenantId: "t1",
  chatId: "c1",
  conversationType,
  from: { aadObjectId: "u1", name: "Ann" },
  text: "hello",
  conversationReference: { ref: 1 },
});

async function setup(assign: boolean) {
  const db = await testDb();
  const turns: RunTurnInput[] = [];
  const runTurn = vi.fn(async (turn: RunTurnInput) => {
    turns.push(turn);
    await turn.askConfirmation({ actionId: "a1", label: "Helper", summary: "Do X", args: "{}" });
    return { text: "reply", costUsd: 0, sessionId: "s" };
  });
  const sent: string[] = [];
  const cards: unknown[] = [];
  const run = async (m: IncomingMessage) => {
    if (assign && !turns.length && !sent.length) {
      // tenant and chat must exist before the assignment can reference them
      const { upsertTenant, upsertChat } = await import("../org/org.js");
      await upsertTenant(db, { id: m.tenantId });
      await upsertChat(db, { id: m.chatId, tenantId: m.tenantId, conversationType: m.conversationType });
      const def = await upsertDefinition(db, Buffer.alloc(32), m.tenantId, { name: "helper", label: "Helper", persona: "p" } as never);
      await assignToChat(db, m.chatId, def.id);
    }
    await handleMessage({ db, runTurn, botName: "Bot" }, m, async (t) => void sent.push(t), async (c) => void cards.push(c));
  };
  return { run, runTurn, sent, cards, turns };
}

describe("handleMessage", () => {
  it("says so and skips the engine when nothing is assigned", async () => {
    const s = await setup(false);
    await s.run(msg("groupChat"));
    expect(s.sent).toEqual(["No bot is set up for this chat yet."]);
    expect(s.runTurn).not.toHaveBeenCalled();
  });

  it("labels the reply in a group chat and sends confirmation cards", async () => {
    const s = await setup(true);
    await s.run(msg("groupChat"));
    expect(s.sent).toEqual(["**Helper**\n\nreply"]);
    expect(s.cards).toHaveLength(1);
    expect(s.turns[0].person.name).toBe("Ann");
  });

  it("sends the plain reply in a personal chat", async () => {
    const s = await setup(true);
    await s.run(msg("personal"));
    expect(s.sent).toEqual(["reply"]);
  });

  it("reports a failure", async () => {
    const s = await setup(true);
    s.runTurn.mockRejectedValueOnce(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await s.run(msg("personal"));
    expect(s.sent).toEqual(["Something went wrong on my side."]);
  });
});

describe("handleMessage ordering", () => {
  it("runs turns in one chat one after another and other chats alongside", async () => {
    const db = await testDb();
    await upsertTenant(db, { id: "t1" });
    const def = await upsertDefinition(db, Buffer.alloc(32), "t1", { name: "helper", label: "Helper", persona: "p" });
    for (const id of ["c1", "c2"]) {
      await upsertChat(db, { id, tenantId: "t1", conversationType: "groupChat" });
      await assignToChat(db, id, def.id);
    }
    const running: { chatId: string; finish: () => void }[] = [];
    const runTurn = vi.fn(async (turn: RunTurnInput) => {
      await new Promise<void>((finish) => running.push({ chatId: turn.chatId, finish }));
      return { text: "reply", costUsd: 0, sessionId: "s" };
    });
    const send = (chatId: string) =>
      handleMessage({ db, runTurn, botName: "Bot" }, { ...msg("groupChat"), chatId }, async () => {}, async () => {});

    const all = [send("c1"), send("c1"), send("c2")];
    await vi.waitFor(() => expect(running.map((r) => r.chatId).sort()).toEqual(["c1", "c2"]));
    await new Promise((r) => setTimeout(r, 50));
    expect(running).toHaveLength(2); // the second c1 turn waits for the first
    running.find((r) => r.chatId === "c1")!.finish();
    await vi.waitFor(() => expect(running).toHaveLength(3));
    expect(running[2]!.chatId).toBe("c1");
    for (const r of running.slice(1)) r.finish();
    await Promise.all(all);
    expect(runTurn).toHaveBeenCalledTimes(3);
  });
});

describe("handleConfirmClick", () => {
  const click = (answer: "yes" | "no", id: string | undefined, c: Confirmations, actionId: string) =>
    handleConfirmClick(c, { actionId, answer }, id, "Bo");

  it("maps the four outcomes", () => {
    const c = new Confirmations();
    const a = c.create({ auditId: "x", askerPersonId: "p1" });
    expect(click("yes", "p2", c, a.actionId)).toBe("Only the person who asked can confirm this.");
    expect(click("yes", undefined, c, a.actionId)).toBe("Only the person who asked can confirm this.");
    expect(click("yes", "p1", c, a.actionId)).toBe("Confirmed by Bo");
    expect(click("yes", "p1", c, a.actionId)).toBe("This request has expired.");
    const b = c.create({ auditId: "y", askerPersonId: "p1" });
    expect(click("no", "p1", c, b.actionId)).toBe("Declined by Bo");
  });
});

describe("clickPayload", () => {
  it("reads the full invoke action", () =>
    expect(clickPayload({ type: "Action.Execute", verb: "confirm", data: { actionId: "a1", answer: "yes" } })).toEqual({ actionId: "a1", answer: "yes" }));
  it("reads bare card data", () => expect(clickPayload({ actionId: "a1", answer: "no" })).toEqual({ actionId: "a1", answer: "no" }));
  it("defaults when empty", () => expect(clickPayload({})).toEqual({ actionId: "", answer: "no" }));
});

it("greets", () => expect(membersAddedGreeting("Bot")).toBe("Hi, I'm Bot. Mention me with a question or a job."));
