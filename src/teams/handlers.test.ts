import { describe, expect, it, vi } from "vitest";
import { assignToChat, upsertDefinition } from "../bots/definitions.js";
import type * as auditModule from "../audit/audit.js";
import { eq } from "drizzle-orm";
import { beginAction, completeAction, recordSent } from "../audit/audit.js";
vi.mock("../audit/audit.js", async (orig) => {
  const actual = await orig<typeof auditModule>();
  return { ...actual, recordSent: vi.fn(actual.recordSent) };
});
import { testDb } from "../db/test-db.js";
import { Confirmations } from "../engine/confirm.js";
import type { RunTurnInput } from "../engine/runner.js";
import { setAllowedDepartments } from "../bots/definitions.js";
import { auditEvents } from "../db/schema.js";
import { createDepartment, setMembership, setRole } from "../org/directory.js";
import { setTenantSettings, upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { clickPayload, handleConfirmClick, handleMessage, membersAddedGreeting, tenantBotName } from "./handlers.js";
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
    return { text: "reply", costUsd: 0, sessionId: "s", changed: false, auditId: "none", timings: { receivedAt: new Date().toISOString(), tools: 0 } };
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
    await handleMessage({ db, runTurn, botName: "Bot" }, m, { send: async (t) => (sent.push(t), undefined), update: async () => {}, sendCard: async (c) => void cards.push(c) });
  };
  return { db, run, runTurn, sent, cards, turns };
}

describe("handleMessage", () => {
  it("sends only the reply when recording the timing fails", async () => {
    const s = await setup(true);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(recordSent).mockRejectedValueOnce(new Error("db down"));
    await s.run(msg("personal"));
    err.mockRestore();
    expect(s.sent).toEqual(["reply"]);
  });

  it("still logs the timing line when recording it fails", async () => {
    const s = await setup(true);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(recordSent).mockRejectedValueOnce(new Error("db down"));
    await s.run(msg("personal"));
    err.mockRestore();
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("turn c1 "));
    log.mockRestore();
    expect(lines).toHaveLength(1);
  });

  it("writes sentAt to the turn's row and logs one timing line without message text", async () => {
    const s = await setup(true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    s.runTurn.mockImplementationOnce(async (turn: RunTurnInput) => {
      const auditId = await beginAction(s.db, { tenantId: turn.tenantId, chatId: turn.chatId, definitionId: turn.definition.id, kind: "message", summary: "x" });
      await completeAction(s.db, auditId, { status: "done", timings: { receivedAt: new Date().toISOString(), tools: 2 } });
      return { text: "secret reply", costUsd: 0, sessionId: "s", changed: false, auditId, timings: { receivedAt: new Date().toISOString(), tools: 2 } };
    });
    // the confirmation card in the default mock is skipped by the override above
    await s.run(msg("personal"));
    const [row] = await s.db.select().from(auditEvents).where(eq(auditEvents.kind, "message"));
    expect(row!.timings!.sentAt).toBeTruthy();
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("turn "));
    log.mockRestore();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^turn \S+ \d+ms ready=-ms first=-ms deliver=-ms tools=2$/);
    expect(lines[0]).not.toContain("secret");
  });

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

describe("handleMessage status message", () => {
  const slowSetup = async (events: (turn: RunTurnInput, wait: (ms: number) => Promise<void>) => Promise<void>) => {
    const s = await setup(true);
    await upsertTenant(s.db, { id: "t1" });
    await upsertChat(s.db, { id: "c1", tenantId: "t1", conversationType: "personal" });
    await assignToChat(s.db, "c1", (await upsertDefinition(s.db, Buffer.alloc(32), "t1", { name: "helper", label: "Helper", persona: "p" })).id);
    s.runTurn.mockImplementation(async (turn: RunTurnInput) => {
      await events(turn, async (ms) => void (await vi.advanceTimersByTimeAsync(ms)));
      return { text: "final", costUsd: 0, sessionId: "s", changed: false, auditId: "none", timings: { receivedAt: new Date().toISOString(), tools: 0 } };
    });
    const log: string[] = [];
    let failUpdate = false;
    const io = {
      send: async (t: string) => (log.push(`send:${t}`), "id1"),
      update: async (id: string, t: string) => {
        if (failUpdate) throw new Error("gone");
        log.push(`update:${id}:${t}`);
      },
      sendCard: async () => {},
    };
    return { s, log, io, failUpdates: () => (failUpdate = true) };
  };
  const run = (x: Awaited<ReturnType<typeof slowSetup>>, type = "personal") =>
    handleMessage({ db: x.s.db, runTurn: x.s.runTurn, botName: "Bot" }, msg(type), x.io);

  it("sends no status message when the turn is fast", async () => {
    vi.useFakeTimers();
    try {
      const x = await slowSetup(async (t, wait) => (t.progress!({ kind: "tool", toolName: "WebSearch" }), wait(2900)));
      await run(x);
      expect(x.log).toEqual(["send:final"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the tool name after 3 s, then the model's latest line, throttled, and ends as the reply", async () => {
    vi.useFakeTimers();
    try {
      const x = await slowSetup(async (t, wait) => {
        t.progress!({ kind: "tool", toolName: "mcp__knowledge__search" });
        await wait(3000);
        t.progress!({ kind: "text", text: "first" });
        t.progress!({ kind: "text", text: `  second\n\nline ${"x".repeat(300)}` });
        await wait(1999);
        expect(x.log).toEqual(["send:**Helper**\n\nWorking: knowledge__search…"]);
        await wait(1);
        await wait(5000);
      });
      const timersBefore = vi.getTimerCount();
      await run(x, "groupChat");
      expect(x.log).toEqual([
        "send:**Helper**\n\nWorking: knowledge__search…",
        `update:id1:**Helper**\n\nsecond line ${"x".repeat(200 - "second line ".length)}`,
        "update:id1:**Helper**\n\nfinal",
      ]);
      expect(vi.getTimerCount()).toBeLessThanOrEqual(timersBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the reply as a new message when the status message cannot be edited", async () => {
    vi.useFakeTimers();
    try {
      const x = await slowSetup(async (t, wait) => {
        t.progress!({ kind: "text", text: "thinking" });
        await wait(3000);
        x.failUpdates();
      });
      await run(x);
      expect(x.log).toEqual(["send:thinking", "send:final"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the reply as a new message once a confirmation card went out", async () => {
    vi.useFakeTimers();
    try {
      const x = await slowSetup(async (t, wait) => {
        t.progress!({ kind: "text", text: "thinking" });
        await wait(3000);
        await t.askConfirmation({ actionId: "a1", label: "Helper", summary: "Do X", args: "{}" });
      });
      await run(x);
      expect(x.log).toEqual(["send:thinking", "send:final"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends at most one status message when Teams returns no activity id", async () => {
    vi.useFakeTimers();
    try {
      const x = await slowSetup(async (t, wait) => {
        t.progress!({ kind: "text", text: "one" });
        await wait(3000);
        t.progress!({ kind: "text", text: "two" });
        await wait(3000);
      });
      x.io.send = async (t: string) => (x.log.push(`send:${t}`), undefined as unknown as string);
      await run(x);
      expect(x.log).toEqual(["send:one", "send:final"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries the role label on the status message in a group chat", async () => {
    vi.useFakeTimers();
    try {
      const x = await slowSetup(async (t, wait) => {
        t.progress!({ kind: "text", text: "thinking" });
        await wait(3000);
        t.progress!({ kind: "text", text: "more" });
        await wait(2000);
      });
      await run(x, "groupChat");
      expect(x.log.slice(0, 2)).toEqual(["send:**Helper**\n\nthinking", "update:id1:**Helper**\n\nmore"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a queued status update and sends the reply at once", async () => {
    vi.useFakeTimers();
    try {
      const x = await slowSetup(async (t, wait) => {
        t.progress!({ kind: "text", text: "one" });
        await wait(3000);
        t.progress!({ kind: "text", text: "two" }); // queued for 2 s later
        await wait(500);
      });
      const timersBefore = vi.getTimerCount();
      await run(x);
      expect(x.log).toEqual(["send:one", "update:id1:final"]);
      expect(vi.getTimerCount()).toBeLessThanOrEqual(timersBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits only for the status call in flight, not for a queued one", async () => {
    vi.useFakeTimers();
    try {
      const x = await slowSetup(async (t, wait) => {
        t.progress!({ kind: "text", text: "one" });
        await wait(3000); // send resolves after 1 s below
        t.progress!({ kind: "text", text: "two" });
      });
      const release: (() => void)[] = [];
      x.io.send = (t: string) => new Promise<string>((r) => (x.log.push(`send:${t}`), release.push(() => r("id1"))));
      const done = run(x);
      await vi.advanceTimersByTimeAsync(3000);
      expect(x.log).toEqual(["send:one"]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(x.log).toEqual(["send:one"]); // reply still waits for the in-flight send
      release[0]!();
      await done;
      expect(x.log).toEqual(["send:one", "update:id1:final"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs how long the reply took to deliver", async () => {
    const x = await slowSetup(async () => {});
    x.s.runTurn.mockImplementation(async () => ({ text: "final", costUsd: 0, sessionId: "s", changed: false, auditId: "none", timings: { receivedAt: new Date().toISOString(), resultAt: new Date().toISOString(), tools: 0 } }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await run(x);
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("turn "));
    log.mockRestore();
    expect(lines[0]).toMatch(/ deliver=\d+ms tools=0$/);
  });

  it("replaces the status message when the turn fails", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const x = await slowSetup(async (t, wait) => {
        t.progress!({ kind: "text", text: "thinking" });
        await wait(3000);
        throw new Error("boom");
      });
      await run(x);
      expect(x.log).toEqual(["send:thinking", "update:id1:Something went wrong on my side."]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("handleMessage streaming", () => {
  const streamSetup = async (events: (turn: RunTurnInput, wait: (ms: number) => Promise<void>) => Promise<void>, text = "final") => {
    const s = await setup(true);
    await upsertTenant(s.db, { id: "t1" });
    await upsertChat(s.db, { id: "c1", tenantId: "t1", conversationType: "personal" });
    await assignToChat(s.db, "c1", (await upsertDefinition(s.db, Buffer.alloc(32), "t1", { name: "helper", label: "Helper", persona: "p" })).id);
    s.runTurn.mockImplementation(async (turn: RunTurnInput) => {
      await events(turn, async (ms) => void (await vi.advanceTimersByTimeAsync(ms)));
      return { text, costUsd: 0, sessionId: "s", changed: false, auditId: "none", timings: { receivedAt: new Date().toISOString(), tools: 0 } };
    });
    const log: string[] = [];
    const fail = { chunk: false, end: false };
    const io = {
      send: async (t: string) => (log.push(`send:${t}`), "id1"),
      update: async (id: string, t: string) => void log.push(`update:${id}:${t}`),
      sendCard: async () => void log.push("card"),
      stream: {
        informative: (t: string) => void log.push(`info:${t}`),
        chunk: (t: string) => {
          if (fail.chunk) throw new Error("gone");
          log.push(`chunk:${t}`);
        },
        end: async (t: string) => {
          if (fail.end) throw new Error("gone");
          log.push(`end:${t}`);
        },
      },
    };
    return { s, log, io, fail };
  };
  const run = (x: Awaited<ReturnType<typeof streamSetup>>, type = "personal") =>
    handleMessage({ db: x.s.db, runTurn: x.s.runTurn, botName: "Bot" }, msg(type), x.io);
  const timed = async (f: () => Promise<void>) => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await f();
    } finally {
      vi.useRealTimers();
      vi.mocked(console.error).mockRestore();
    }
  };

  it("streams each delta as it arrives and ends with exactly the reply", () =>
    timed(async () => {
      const x = await streamSetup(async (t) => {
        t.progress!({ kind: "delta", text: "Hel" });
        expect(x.log).toEqual(["chunk:Hel"]);
        t.progress!({ kind: "delta", text: "lo" });
        t.progress!({ kind: "text", text: "Hello" });
        t.progress!({ kind: "message-end" });
        expect(x.log).toEqual(["chunk:Hel", "chunk:lo"]);
      });
      await run(x);
      expect(x.log).toEqual(["chunk:Hel", "chunk:lo", "end:final"]);
    }));

  it("shows tools as informative updates until text starts, then none; a later message follows a blank line and the final message is exactly the reply", () =>
    timed(async () => {
      const x = await streamSetup(async (t, wait) => {
        t.progress!({ kind: "tool", toolName: "mcp__knowledge__search" });
        await wait(3000);
        t.progress!({ kind: "delta", text: "Let me check." });
        t.progress!({ kind: "tool", toolName: "WebSearch" });
        t.progress!({ kind: "message-end" });
        await wait(3000);
        t.progress!({ kind: "delta", text: "Answer" });
        t.progress!({ kind: "message-end" });
      });
      await run(x);
      expect(x.log).toEqual(["info:Working: knowledge__search…", "chunk:Let me check.", "chunk:\n\nAnswer", "end:final"]);
    }));

  it("ends the stream with the text so far before a confirmation card and sends the reply after it as a new message", () =>
    timed(async () => {
      const x = await streamSetup(async (t, wait) => {
        t.progress!({ kind: "tool", toolName: "WebSearch" });
        await wait(3000);
        t.progress!({ kind: "delta", text: "Checking" });
        await t.askConfirmation({ actionId: "a1", label: "Helper", summary: "Do X", args: "{}" });
        t.progress!({ kind: "delta", text: "Done" });
        t.progress!({ kind: "message-end" });
      });
      await run(x);
      expect(x.log).toEqual(["info:Working: WebSearch…", "chunk:Checking", "end:Checking", "card", "send:final"]);
    }));

  it("falls back to the status message when a stream call throws and sends one reply", () =>
    timed(async () => {
      const x = await streamSetup(async (t, wait) => {
        t.progress!({ kind: "delta", text: "Hi" });
        t.progress!({ kind: "message-end" });
        t.progress!({ kind: "text", text: "working on it" });
        await wait(3000);
      });
      x.fail.chunk = true;
      await run(x);
      expect(x.log).toEqual(["send:working on it", "update:id1:final"]);
    }));

  it("sends the reply as a message when ending the stream fails", () =>
    timed(async () => {
      const x = await streamSetup(async (t) => {
        t.progress!({ kind: "delta", text: "Hi" });
        t.progress!({ kind: "message-end" });
      });
      x.fail.end = true;
      await run(x);
      expect(x.log).toEqual(["chunk:Hi", "send:final"]);
    }));

  it("never streams in a group chat", () =>
    timed(async () => {
      const x = await streamSetup(async (t, wait) => {
        t.progress!({ kind: "delta", text: "Hi" });
        t.progress!({ kind: "message-end" });
        t.progress!({ kind: "text", text: "Hi" });
        await wait(3000);
      });
      await run(x, "groupChat");
      expect(x.log).toEqual(["send:**Helper**\n\nHi", "update:id1:**Helper**\n\nfinal"]);
    }));

  it("records sentAt and logs the timing line on the streamed path", () =>
    timed(async () => {
      const x = await streamSetup(async (t) => {
        t.progress!({ kind: "delta", text: "Hi" });
        t.progress!({ kind: "message-end" });
      });
      x.s.runTurn.mockImplementationOnce(async (turn: RunTurnInput) => {
        turn.progress!({ kind: "delta", text: "Hi" });
        turn.progress!({ kind: "message-end" });
        const auditId = await beginAction(x.s.db, { tenantId: turn.tenantId, chatId: turn.chatId, definitionId: turn.definition.id, kind: "message", summary: "x" });
        await completeAction(x.s.db, auditId, { status: "done", timings: { receivedAt: new Date().toISOString(), tools: 0 } });
        return { text: "Hi", costUsd: 0, sessionId: "s", changed: false, auditId, timings: { receivedAt: new Date().toISOString(), tools: 0 } };
      });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await run(x);
      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("turn "));
      log.mockRestore();
      expect(x.log).toEqual(["chunk:Hi", "end:Hi"]);
      const [row] = await x.s.db.select().from(auditEvents).where(eq(auditEvents.kind, "message"));
      expect(row!.timings!.sentAt).toBeTruthy();
      expect(lines).toHaveLength(1);
    }));
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
      return { text: "reply", costUsd: 0, sessionId: "s", changed: false, auditId: "none", timings: { receivedAt: new Date().toISOString(), tools: 0 } };
    });
    const send = (chatId: string) =>
      handleMessage({ db, runTurn, botName: "Bot" }, { ...msg("groupChat"), chatId }, { send: async () => undefined, update: async () => {}, sendCard: async () => {} });

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

  it("maps the four outcomes", async () => {
    const c = new Confirmations();
    const mayConfirm = async (p: string) => p === "p1";
    const a = c.create({ auditId: "x", mayConfirm });
    await expect(click("yes", "p2", c, a.actionId)).resolves.toBe("You can't confirm this.");
    await expect(click("yes", undefined, c, a.actionId)).resolves.toBe("You can't confirm this.");
    await expect(click("yes", "p1", c, a.actionId)).resolves.toBe("Confirmed by Bo");
    await expect(click("yes", "p1", c, a.actionId)).resolves.toBe("This request has expired.");
    const b = c.create({ auditId: "y", mayConfirm });
    await expect(click("no", "p1", c, b.actionId)).resolves.toBe("Declined by Bo");
  });
});

describe("clickPayload", () => {
  it("reads the full invoke action", () =>
    expect(clickPayload({ type: "Action.Execute", verb: "confirm", data: { actionId: "a1", answer: "yes" } })).toEqual({ actionId: "a1", answer: "yes" }));
  it("reads bare card data", () => expect(clickPayload({ actionId: "a1", answer: "no" })).toEqual({ actionId: "a1", answer: "no" }));
  it("defaults when empty", () => expect(clickPayload({})).toEqual({ actionId: "", answer: "no" }));
});

it("greets", () => expect(membersAddedGreeting("Bot")).toBe("Hi, I'm Bot. Mention me with a question or a job."));

it("greets with the tenant bot name when set", async () => {
  const db = await testDb();
  await upsertTenant(db, { id: "t1" });
  expect(membersAddedGreeting(await tenantBotName(db, "t1", "Bot"))).toContain("I'm Bot.");
  await setTenantSettings(db, "t1", { botName: "Helper", retentionDays: 90, defaultModel: null, timezone: "UTC" });
  expect(membersAddedGreeting(await tenantBotName(db, "t1", "Bot"))).toBe("Hi, I'm Helper. Mention me with a question or a job.");
});

it("greets with the fallback name when the settings lookup fails", async () => {
  const db = { select: () => { throw new Error("db down"); } } as never;
  expect(await tenantBotName(db, "t1", "Bot")).toBe("Bot");
});

describe("handleMessage department access", () => {
  async function restricted() {
    const db = await testDb();
    await upsertTenant(db, { id: "t1" });
    await upsertChat(db, { id: "c1", tenantId: "t1", conversationType: "personal" });
    const def = await upsertDefinition(db, Buffer.alloc(32), "t1", { name: "helper", label: "Helper", persona: "p" });
    await assignToChat(db, "c1", def.id);
    const sales = await createDepartment(db, "t1", "Sales");
    await setAllowedDepartments(db, "t1", def.id, [sales.id]);
    const mem = await upsertPerson(db, { tenantId: "t1", aadObjectId: "member", name: "Mo" });
    await setMembership(db, "t1", sales.id, mem.id, "member");
    const adm = await upsertPerson(db, { tenantId: "t1", aadObjectId: "admin", name: "Ad" });
    await setRole(db, "t1", adm.id, "admin");
    const runTurn = vi.fn(async () => ({ text: "reply", costUsd: 0, sessionId: "s", changed: false, auditId: "none", timings: { receivedAt: new Date().toISOString(), tools: 0 } }));
    const as = async (aadObjectId: string) => {
      const sent: string[] = [];
      await handleMessage({ db, runTurn, botName: "Bot" }, { ...msg("personal"), from: { aadObjectId, name: aadObjectId } }, { send: async (t) => (sent.push(t), undefined), update: async () => {}, sendCard: async () => {} });
      return sent;
    };
    return { db, runTurn, as };
  }

  it("serves a member of a linked department and an admin", async () => {
    const s = await restricted();
    expect(await s.as("member")).toEqual(["reply"]);
    expect(await s.as("admin")).toEqual(["reply"]);
    expect(s.runTurn).toHaveBeenCalledTimes(2);
  });

  it("refuses anyone else without a model call or audit row", async () => {
    const s = await restricted();
    expect(await s.as("stranger")).toEqual(["You don't have access to this bot."]);
    expect(s.runTurn).not.toHaveBeenCalled();
    expect(await s.db.select().from(auditEvents)).toEqual([]);
  });
});
