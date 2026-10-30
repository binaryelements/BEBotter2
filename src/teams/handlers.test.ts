import { describe, expect, it, vi } from "vitest";
import { assignToChat, upsertDefinition } from "../bots/definitions.js";
import { testDb } from "../db/test-db.js";
import { Confirmations } from "../engine/confirm.js";
import type { RunTurnInput } from "../engine/runner.js";
import { handleConfirmClick, handleMessage, membersAddedGreeting } from "./handlers.js";
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

it("greets", () => expect(membersAddedGreeting("Bot")).toBe("Hi, I'm Bot. Mention me with a question or a job."));
