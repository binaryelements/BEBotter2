import { describe, expect, it, vi } from "vitest";
import { assignToChat, ensurePersonalDefinition, setChatDefinition, upsertDefinition } from "../bots/definitions.js";
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
import { auditEvents, botDefinitions, chatAssignments, chats } from "../db/schema.js";
import { createDepartment, setMembership, setPersonalBot, setRole } from "../org/directory.js";
import { recordChatOwner, setTenantSettings, upsertChat, upsertPerson, upsertTenant } from "../org/org.js";
import { SLOW_NOTE, addressedByName, choosePayload, clickPayload, handleChoose, handleConfirmClick, handleInstall, handleMessage, membersAddedGreeting, needsSignIn, tenantBotName } from "./handlers.js";
import { confirmerPolicy } from "../admin/access.js";
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
    await turn.askConfirmation({ actionId: "a1", label: "Helper", toolName: "mcp__tickets__close", input: {} });
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
    await handleMessage({ db, runTurn, botName: "Bot", defaultModel: "m" }, m, { send: async (t) => (sent.push(t), undefined), update: async () => {}, sendCard: async (c) => void cards.push(c) });
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
    expect(s.sent).toEqual(["**Helper**\n\nreply"]);
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
    expect(s.sent).toEqual(["No bot is set up for this chat yet. An admin can choose one by mentioning me with switch, or on the admin site under Assignments."]);
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
    expect(s.sent).toEqual(["**Helper**\n\nreply"]);
  });

  it("reports a failure", async () => {
    const s = await setup(true);
    s.runTurn.mockRejectedValueOnce(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await s.run(msg("personal"));
    expect(s.sent).toEqual(["**Helper**\n\nSomething went wrong on my side."]);
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
    handleMessage({ db: x.s.db, runTurn: x.s.runTurn, botName: "Bot", defaultModel: "m" }, msg(type), x.io);

  it("sends no status message when the turn is fast", async () => {
    vi.useFakeTimers();
    try {
      const x = await slowSetup(async (t, wait) => (t.progress!({ kind: "tool", toolName: "WebSearch" }), wait(2900)));
      await run(x);
      expect(x.log).toEqual(["send:**Helper**\n\nfinal"]);
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
        expect(x.log).toEqual(["send:**Helper**\n\nWorking: search…"]);
        await wait(1);
        await wait(5000);
      });
      const timersBefore = vi.getTimerCount();
      await run(x, "groupChat");
      expect(x.log).toEqual([
        "send:**Helper**\n\nWorking: search…",
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
      expect(x.log).toEqual(["send:thinking", "send:**Helper**\n\nfinal"]);
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
        await t.askConfirmation({ actionId: "a1", label: "Helper", toolName: "mcp__tickets__close", input: {} });
      });
      await run(x);
      expect(x.log).toEqual(["send:thinking", "send:**Helper**\n\nfinal"]);
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
      expect(x.log).toEqual(["send:one", "send:**Helper**\n\nfinal"]);
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
      expect(x.log).toEqual(["send:one", "update:id1:**Helper**\n\nfinal"]);
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
      expect(x.log).toEqual(["send:one", "update:id1:**Helper**\n\nfinal"]);
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
      expect(x.log).toEqual(["send:thinking", "update:id1:**Helper**\n\nSomething went wrong on my side."]);
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
        end: async (t: string, card?: unknown) => {
          if (fail.end) throw new Error("gone");
          log.push(`end:${t}${card ? "+card" : ""}`);
        },
      },
    };
    return { s, log, io, fail };
  };
  const run = (x: Awaited<ReturnType<typeof streamSetup>>, type = "personal") =>
    handleMessage({ db: x.s.db, runTurn: x.s.runTurn, botName: "Bot", defaultModel: "m" }, msg(type), x.io);
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

  it("streams the bot's name then each delta, and ends with what was streamed: Teams refuses a final message that does not carry on from it", () =>
    timed(async () => {
      const x = await streamSetup(async (t) => {
        t.progress!({ kind: "delta", text: "Hel" });
        expect(x.log).toEqual(["chunk:**Helper**\n\nHel"]);
        t.progress!({ kind: "delta", text: "lo" });
        t.progress!({ kind: "text", text: "Hello" });
        t.progress!({ kind: "message-end" });
        expect(x.log).toEqual(["chunk:**Helper**\n\nHel", "chunk:lo"]);
      }, "Hello");
      await run(x);
      expect(x.log).toEqual(["chunk:**Helper**\n\nHel", "chunk:lo", "end:**Helper**\n\nHello"]);
    }));

  it("a reply the stream never showed is added after what was streamed, never in place of it", () =>
    timed(async () => {
      const x = await streamSetup(async (t) => {
        t.progress!({ kind: "delta", text: "Looking" });
      }, "Here it is");
      await run(x);
      expect(x.log).toEqual(["chunk:**Helper**\n\nLooking", "end:**Helper**\n\nLooking\n\nHere it is"]);
    }));

  it("shows tools as informative updates until text starts, then none; a later message follows a blank line and the final message keeps it all", () =>
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
      }, "Answer");
      await run(x);
      expect(x.log).toEqual(["info:Working: search…", "chunk:**Helper**\n\nLet me check.", "chunk:\n\nAnswer", "end:**Helper**\n\nLet me check.\n\nAnswer"]);
    }));

  it("ends the stream with the text so far before a confirmation card and sends the reply after it as a new message", () =>
    timed(async () => {
      const x = await streamSetup(async (t, wait) => {
        t.progress!({ kind: "tool", toolName: "WebSearch" });
        await wait(3000);
        t.progress!({ kind: "delta", text: "Checking" });
        await t.askConfirmation({ actionId: "a1", label: "Helper", toolName: "mcp__tickets__close", input: {} });
        t.progress!({ kind: "delta", text: "Done" });
        t.progress!({ kind: "message-end" });
      });
      await run(x);
      expect(x.log).toEqual(["info:Working: WebSearch…", "chunk:**Helper**\n\nChecking", "end:**Helper**\n\nChecking+card", "send:**Helper**\n\nfinal"]);
    }));

  it("says once that it is still working when a reply passes 45 s, as a progress line or after the streamed text", () =>
    timed(async () => {
      const quiet = await streamSetup(async (t, wait) => {
        t.progress!({ kind: "tool", toolName: "WebSearch" });
        await wait(46_000);
      }, "Answer");
      await run(quiet);
      expect(quiet.log).toEqual(["info:Working: WebSearch…", `info:${SLOW_NOTE}`, "end:**Helper**\n\nAnswer"]);

      const talking = await streamSetup(async (t, wait) => {
        t.progress!({ kind: "delta", text: "Checking flights." });
        await wait(46_000);
        t.progress!({ kind: "delta", text: "Found them" });
      }, "Found them");
      await run(talking);
      expect(talking.log).toEqual([
        "chunk:**Helper**\n\nChecking flights.",
        `chunk:\n\n${SLOW_NOTE}`,
        "chunk:\n\nFound them",
        `end:**Helper**\n\nChecking flights.\n\n${SLOW_NOTE}\n\nFound them`,
      ]);
    }));

  it("ends a stream that only showed progress with the card alone, so no progress line stays", () =>
    timed(async () => {
      const x = await streamSetup(async (t, wait) => {
        t.progress!({ kind: "tool", toolName: "mcp__mail__reply_to_email" });
        await wait(3000);
        await t.askConfirmation({ actionId: "a1", label: "Helper", toolName: "mcp__mail__reply_to_email", input: {} });
      });
      await run(x);
      expect(x.log).toEqual(["info:Working: reply to email…", "end:+card", "send:**Helper**\n\nfinal"]);
    }));

  it("sends the card as its own message when ending the stream with it fails", () =>
    timed(async () => {
      const x = await streamSetup(async (t, wait) => {
        t.progress!({ kind: "tool", toolName: "WebSearch" });
        await wait(3000);
        x.fail.end = true;
        await t.askConfirmation({ actionId: "a1", label: "Helper", toolName: "WebSearch", input: {} });
      });
      await run(x);
      expect(x.log).toEqual(["info:Working: WebSearch…", "card", "send:**Helper**\n\nfinal"]);
    }));

  it("sends no status message around a confirmation card in a chat that streams", () =>
    timed(async () => {
      const x = await streamSetup(async (t, wait) => {
        t.progress!({ kind: "tool", toolName: "mcp__tickets__close" });
        await t.askConfirmation({ actionId: "a1", label: "Helper", toolName: "mcp__tickets__close", input: {} });
        await wait(5000);
        t.progress!({ kind: "tool", toolName: "mcp__tickets__close" });
        await wait(5000);
      });
      await run(x);
      expect(x.log).toEqual(["card", "send:**Helper**\n\nfinal"]);
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
      expect(x.log).toEqual(["send:working on it", "update:id1:**Helper**\n\nfinal"]);
    }));

  it("sends the reply as a message when ending the stream fails", () =>
    timed(async () => {
      const x = await streamSetup(async (t) => {
        t.progress!({ kind: "delta", text: "Hi" });
        t.progress!({ kind: "message-end" });
      });
      x.fail.end = true;
      await run(x);
      expect(x.log).toEqual(["chunk:**Helper**\n\nHi", "send:**Helper**\n\nfinal"]);
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
      expect(x.log).toEqual(["chunk:**Helper**\n\nHi", "end:**Helper**\n\nHi"]);
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
      handleMessage({ db, runTurn, botName: "Bot", defaultModel: "m" }, { ...msg("groupChat"), chatId }, { send: async () => undefined, update: async () => {}, sendCard: async () => {} });

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
  await setTenantSettings(db, "t1", { botName: "Helper", retentionDays: 90, defaultModel: null, timezone: "UTC", location: null, country: null });
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
      await handleMessage({ db, runTurn, botName: "Bot", defaultModel: "m" }, { ...msg("personal"), from: { aadObjectId, name: aadObjectId } }, { send: async (t) => (sent.push(t), undefined), update: async () => {}, sendCard: async () => {} });
      return sent;
    };
    return { db, runTurn, as };
  }

  it("serves a member of a linked department and an admin", async () => {
    const s = await restricted();
    expect(await s.as("member")).toEqual(["**Helper**\n\nreply"]);
    expect(await s.as("admin")).toEqual(["**Helper**\n\nreply"]);
    expect(s.runTurn).toHaveBeenCalledTimes(2);
  });

  it("refuses anyone else without a model call or audit row", async () => {
    const s = await restricted();
    expect(await s.as("stranger")).toEqual(["You no longer have access to Helper."]);
    expect(s.runTurn).not.toHaveBeenCalled();
    expect(await s.db.select().from(auditEvents)).toEqual([]);
  });
});

describe("choosing the bot in a one-to-one chat", () => {
  async function chat() {
    const db = await testDb();
    await upsertTenant(db, { id: "t1" });
    const ann = await upsertPerson(db, { tenantId: "t1", aadObjectId: "u1", name: "Ann" });
    const bob = await upsertPerson(db, { tenantId: "t1", aadObjectId: "u2", name: "Bob" });
    const runTurn = vi.fn(async () => ({ text: "reply", costUsd: 0, sessionId: "s", changed: false, auditId: "none", timings: { receivedAt: new Date().toISOString(), tools: 0 } }));
    const deps = { db, runTurn, botName: "Bot", defaultModel: "m" };
    const sent: string[] = [];
    const cards: any[] = [];
    const io = { send: async (t: string) => (sent.push(t), undefined), update: async () => {}, sendCard: async (c: unknown) => void cards.push(c) };
    const say = (text: string, from = "u1") => handleMessage(deps, { ...msg("personal"), text, from: { aadObjectId: from, name: from } }, io);
    const assigned = async () => (await db.select().from(chatAssignments).where(eq(chatAssignments.chatId, "c1"))).map((a) => a.definitionId);
    const service = (name: string, label: string) => upsertDefinition(db, Buffer.alloc(32), "t1", { name, label, persona: "p" } as never);
    const titles = (c: any) => c.actions.map((a: any) => a.title);
    return { db, ann, bob, deps, runTurn, sent, cards, io, say, assigned, service, titles };
  }

  it("records the chat owner on the first message", async () => {
    const s = await chat();
    await s.say("hi");
    const [c] = await s.db.select().from(chats).where(eq(chats.id, "c1"));
    expect(c.ownerPersonId).toBe(s.ann.id);
  });

  it("answers directly with the one usable bot and assigns it", async () => {
    const s = await chat();
    const a = await s.service("helper", "Helper");
    await s.say("hi");
    expect(s.sent).toEqual(["**Helper**\n\nreply"]);
    expect(await s.assigned()).toEqual([a.id]);
  });

  it("sends the card, with no turn, when several bots are usable; Personal first", async () => {
    const s = await chat();
    await s.service("zed", "Zed");
    await s.service("abe", "Abe");
    await setPersonalBot(s.db, "t1", s.ann.id, true);
    await s.say("hi");
    expect(s.runTurn).not.toHaveBeenCalled();
    expect(s.cards).toHaveLength(1);
    expect(s.cards[0].body[0].text).toBe("Who would you like to talk to?");
    expect(s.titles(s.cards[0])).toEqual(["My assistant", "Abe", "Zed"]);
    expect(s.cards[0].actions[1]).toMatchObject({ type: "Action.Execute", verb: "choose" });
    expect(await s.assigned()).toEqual([]);
  });

  it("says so when no bot is usable", async () => {
    const s = await chat();
    await s.say("hi");
    expect(s.sent).toEqual(["No bot is available to you yet. Ask an admin."]);
    expect(s.runTurn).not.toHaveBeenCalled();
  });

  it("shows the card for a lone `switch`, in any case, instead of a turn", async () => {
    const s = await chat();
    const a = await s.service("helper", "Helper");
    await s.service("other", "Other");
    await s.say("hi"); // card (two usable), nothing assigned yet
    await setChatDefinition(s.db, "t1", "c1", a.id);
    await s.say("  Switch ");
    expect(s.runTurn).not.toHaveBeenCalled();
    expect(s.cards).toHaveLength(2);
  });

  it("shows access lost and the card when the assigned bot is no longer usable", async () => {
    const s = await chat();
    const a = await s.service("helper", "Helper");
    const b = await s.service("other", "Other");
    await s.say("hi");
    await setChatDefinition(s.db, "t1", "c1", a.id);
    const sales = await createDepartment(s.db, "t1", "Sales");
    await setAllowedDepartments(s.db, "t1", a.id, [sales.id]);
    s.sent.length = s.cards.length = 0;
    await s.say("hi again");
    expect(s.runTurn).not.toHaveBeenCalled();
    expect(s.sent).toEqual(["You no longer have access to Helper."]);
    expect(s.titles(s.cards[0])).toEqual(["Other"]);
    expect(s.cards[0].actions[0].data).toEqual({ definitionId: b.id });
  });

  it("the owner's choose replaces the assignment and refreshes the card", async () => {
    const s = await chat();
    const a = await s.service("helper", "Helper");
    const b = await s.service("other", "Other");
    await s.say("hi");
    await setChatDefinition(s.db, "t1", "c1", a.id);
    const card: any = await handleChoose(s.deps, { tenantId: "t1", chatId: "c1", personId: s.ann.id }, b.id);
    expect(await s.assigned()).toEqual([b.id]);
    expect(JSON.stringify(card)).toContain("You're now talking to Other.");
  });

  it("in a one-to-one chat a bot's name switches to it: alone it only switches, with a question it also answers", async () => {
    const s = await chat();
    const a = await s.service("helper", "Helper");
    const b = await s.service("it", "IT Support");
    await s.db.update(botDefinitions).set({ displayName: "Mickey" }).where(eq(botDefinitions.id, b.id));
    await s.say("hi"); // two bots, none chosen: the card
    await setChatDefinition(s.db, "t1", "c1", a.id);
    await s.say("mickey");
    expect(s.runTurn).not.toHaveBeenCalled();
    expect(await s.assigned()).toEqual([b.id]);
    expect(JSON.stringify(s.cards[1])).toContain("You're now talking to Mickey · IT Support.");
    await s.say("Helper, what's up?");
    expect(await s.assigned()).toEqual([a.id]);
    expect(s.sent).toEqual(["**Helper**\n\nreply"]);
    expect((s.runTurn.mock.calls[0] as any)[0].text).toBe("Helper, what's up?");
    await s.say("hi mickey!");
    expect(await s.assigned()).toEqual([b.id]);
    expect(s.cards).toHaveLength(3);
    expect(s.runTurn).toHaveBeenCalledTimes(1);
  });

  it("refuses a choose from anyone but the owner, or of a bot the owner may not use, and changes nothing", async () => {
    const s = await chat();
    const a = await s.service("helper", "Helper");
    const b = await s.service("other", "Other");
    const c = await s.service("secret", "Secret");
    const sales = await createDepartment(s.db, "t1", "Sales");
    await setAllowedDepartments(s.db, "t1", c.id, [sales.id]);
    await s.say("hi");
    await setChatDefinition(s.db, "t1", "c1", a.id);
    const by = (personId: string, id: string) => handleChoose(s.deps, { tenantId: "t1", chatId: "c1", personId }, id);
    expect(JSON.stringify(await by(s.bob.id, b.id))).toContain("You can't choose this bot.");
    expect(JSON.stringify(await by(s.ann.id, c.id))).toContain("You can't choose this bot.");
    expect(JSON.stringify(await by(s.ann.id, "forged"))).toContain("You can't choose this bot.");
    expect(await s.assigned()).toEqual([a.id]);
  });

  it("in a group chat an admin gets the card of company bots and chooses; anyone else is told how, and can't choose", async () => {
    const s = await chat();
    const a = await s.service("helper", "Helper");
    await ensurePersonalDefinition(s.db, "t1", "m");
    await setRole(s.db, "t1", s.ann.id, "admin");
    const group = (text: string, from: string) => handleMessage(s.deps, { ...msg("groupChat"), text, from: { aadObjectId: from, name: from } }, s.io);
    await group("hello", "u2");
    expect(s.sent).toEqual(["No bot is set up for this chat yet. An admin can choose one by mentioning me with switch, or on the admin site under Assignments."]);
    await group("hello", "u1");
    expect(s.titles(s.cards[0])).toEqual(["Helper"]);
    expect(JSON.stringify(await handleChoose(s.deps, { tenantId: "t1", chatId: "c1", personId: s.bob.id }, a.id))).toContain("You can't choose this bot.");
    expect(await s.assigned()).toEqual([]);
    expect(JSON.stringify(await handleChoose(s.deps, { tenantId: "t1", chatId: "c1", personId: s.ann.id }, a.id))).toContain("You're now talking to Helper.");
    expect(await s.assigned()).toEqual([a.id]);
    await group("switch", "u1");
    expect(s.cards).toHaveLength(2);
    expect(s.runTurn).not.toHaveBeenCalled();
  });

  it("in a group chat it hears without answering, then answers a mention or its name with what it heard", async () => {
    const s = await chat();
    const a = await s.service("it", "IT Support");
    await s.db.update(botDefinitions).set({ displayName: "Mickey" }).where(eq(botDefinitions.id, a.id));
    const group = (text: string, mentioned: boolean, from = "u2", mentionedOthers = false) => handleMessage(s.deps, { ...msg("groupChat"), text, mentioned, mentionedOthers, from: { aadObjectId: from, name: from === "u1" ? "Ann" : "Bob" } }, s.io);
    await group("the printer is down", false);
    await setChatDefinition(s.db, "t1", "c1", a.id);
    await group("I'll check the toner", false, "u1");
    expect(s.runTurn).not.toHaveBeenCalled();
    expect(s.sent).toEqual([]);
    // a photo posted without a word is kept too, and the bot is told what is at hand when it is finally asked
    const photo = { name: "toner.png", mediaType: "image/png", download: async () => Buffer.from("png") };
    await handleMessage(s.deps, { ...msg("groupChat"), text: "", attachments: [photo], mentioned: false, from: { aadObjectId: "u1", name: "Ann" } }, s.io);
    await group("mickey, r u there?", false);
    expect(s.runTurn).toHaveBeenCalledTimes(1);
    const text = (s.runTurn.mock.calls[0] as any)[0].text as string;
    expect(text).toMatch(/^\[Files and images posted in this chat, newest first; open one with read_attachment and its id when it matters:\n- toner\.png \(image\/png, id [0-9a-f-]{36}\) from Ann, with this message\]\n\n/);
    expect(text.split("\n\n").slice(1).join("\n\n")).toBe("[Said in this group chat since your last reply; you were not addressed, so you did not answer:\nBob: the printer is down\nAnn: I'll check the toner\nAnn: [sent toner.png]]\n\nmickey, r u there?");
    await group("fixed now", true);
    // the photo stays listed for ten minutes, so a later "what was that?" can open it
    const body = (t: string) => t.replace(/^\[Files and images posted[\s\S]*?\]\n\n/, "");
    expect((s.runTurn.mock.calls[1] as any)[0].text).toMatch(/^\[Files and images posted/);
    expect(body((s.runTurn.mock.calls[1] as any)[0].text)).toBe("fixed now");
    // follow-ups: for two minutes after the bot answered Bob, Bob needs no name; Ann does, and so does Bob when he talks to Ann
    const bob = await upsertPerson(s.db, { tenantId: "t1", aadObjectId: "u2", name: "Bob" });
    const answered = await beginAction(s.db, { tenantId: "t1", chatId: "c1", definitionId: a.id, personId: bob.id, kind: "message", summary: "fixed now" });
    await completeAction(s.db, answered, { status: "done" });
    await group("fine", false, "u1");
    await group("Ann, can you check the toner", false);
    await group("thanks all", false, "u2", true);
    expect(s.runTurn).toHaveBeenCalledTimes(2);
    await group("check zfs", false);
    expect(body((s.runTurn.mock.calls[2] as any)[0].text)).toBe("[Said in this group chat since your last reply; you were not addressed, so you did not answer:\nAnn: fine\nBob: Ann, can you check the toner\nBob: thanks all]\n\ncheck zfs");
    await s.db.update(auditEvents).set({ finishedAt: new Date(Date.now() - 3 * 60_000) }).where(eq(auditEvents.id, answered));
    await group("still there?", false);
    expect(s.runTurn).toHaveBeenCalledTimes(3);
    expect(addressedByName("Hey Mickey: help", { displayName: "Mickey", label: "IT" })).toBe(true);
    expect(addressedByName("Mickeys are mice", { displayName: "Mickey", label: "IT" })).toBe(false);
    expect(addressedByName("it support, help", { displayName: null, label: "IT Support" })).toBe(true);
  });

  it("leaves My assistant off the card of a person without the flag", async () => {
    const s = await chat();
    await s.service("a", "A");
    await s.service("b", "B");
    await ensurePersonalDefinition(s.db, "t1", "m");
    await s.say("hi");
    expect(s.titles(s.cards[0])).toEqual(["A", "B"]);
  });

  it("refuses a choose of another tenant's bot and changes nothing", async () => {
    const s = await chat();
    const a = await s.service("helper", "Helper");
    await upsertTenant(s.db, { id: "t2" });
    const foreign = await upsertDefinition(s.db, Buffer.alloc(32), "t2", { name: "x", label: "X", persona: "p" } as never);
    await s.say("hi");
    await setChatDefinition(s.db, "t1", "c1", a.id);
    expect(JSON.stringify(await handleChoose(s.deps, { tenantId: "t1", chatId: "c1", personId: s.ann.id }, foreign.id))).toContain("You can't choose this bot.");
    expect(await s.assigned()).toEqual([a.id]);
  });

  it("refuses Personal in a group chat, and for anyone but the chat's owner, without a turn", async () => {
    const s = await chat();
    const personal = await ensurePersonalDefinition(s.db, "t1", "m");
    await setPersonalBot(s.db, "t1", s.ann.id, true);
    await setPersonalBot(s.db, "t1", s.bob.id, true);
    await upsertChat(s.db, { id: "g1", tenantId: "t1", conversationType: "groupChat" });
    await s.db.insert(chatAssignments).values({ chatId: "g1", definitionId: personal.id });
    await handleMessage(s.deps, { ...msg("groupChat"), chatId: "g1" }, { ...s.io, graphToken: async () => "t" });
    await handleMessage(s.deps, { ...msg("personal"), text: "hi" }, { ...s.io, graphToken: async () => "t" }); // Ann's own chat: Personal is her only bot, so it is assigned and answers
    await s.say("hello", "u2");
    const refusal = "This assistant is private to its owner.";
    expect(s.sent).toEqual([refusal, "**My assistant**\n\nreply", refusal]);
    expect(s.runTurn).toHaveBeenCalledTimes(1); // Ann's only
    expect(await s.db.select().from(auditEvents)).toEqual([]);
  });

  describe("the person's token", () => {
    const token = "tok-ann-secret";
    async function mine() {
      const s = await chat();
      const personal = await ensurePersonalDefinition(s.db, "t1", "m");
      await setPersonalBot(s.db, "t1", s.ann.id, true);
      const graphToken = vi.fn(async () => token);
      const signedIn = { ...s.io, graphToken };
      return { ...s, personal, graphToken, signedIn };
    }
    const check = (m: Partial<Parameters<typeof needsSignIn>[1]> = {}) => ({ tenantId: "t1", chatId: "c1", conversationType: "personal", aadObjectId: "u1", text: "hi", ...m });

    it("a person turn gets the turn's token closure; a service turn never does", async () => {
      const s = await mine();
      await handleMessage(s.deps, { ...msg("personal"), text: "hi" }, s.signedIn);
      const helper = await s.service("helper", "Helper");
      await upsertChat(s.db, { id: "g1", tenantId: "t1", conversationType: "groupChat" });
      await assignToChat(s.db, "g1", helper.id);
      await handleMessage(s.deps, { ...msg("groupChat"), chatId: "g1" }, s.signedIn);
      const turns = s.runTurn.mock.calls.map((c) => (c as unknown as [RunTurnInput])[0]);
      expect(turns.map((t) => t.definition.id)).toEqual([s.personal.id, helper.id]);
      expect(turns[0]!.graphToken).toBe(s.graphToken);
      expect(turns[1]!.graphToken).toBeUndefined();
      expect(s.graphToken).not.toHaveBeenCalled(); // fetched per Graph call, not up front
    });

    it("a person turn without a token runs no engine", async () => {
      const s = await mine();
      await s.say("hi");
      expect(s.runTurn).not.toHaveBeenCalled();
      expect(s.sent).toEqual(["Say that again, please."]); // the route chose before the assignment changed: the next message signs in
    });

    it("signs in only for the owner's own turn of Personal", async () => {
      const s = await mine();
      expect(await needsSignIn(s.deps, check())).toBe(true); // Personal is her only bot: the first message assigns it
      await s.service("helper", "Helper");
      expect(await needsSignIn(s.deps, check())).toBe(false); // two usable, none assigned: the card, no turn
      await upsertChat(s.db, { id: "c1", tenantId: "t1", conversationType: "personal" });
      await recordChatOwner(s.db, "c1", s.ann.id);
      await setChatDefinition(s.db, "t1", "c1", s.personal.id);
      expect(await needsSignIn(s.deps, check())).toBe(true);
      expect(await needsSignIn(s.deps, check({ text: " switch " }))).toBe(false);
      expect(await needsSignIn(s.deps, check({ aadObjectId: "u2" }))).toBe(false);
      expect(await needsSignIn(s.deps, check({ aadObjectId: "nobody" }))).toBe(false);
      expect(await needsSignIn(s.deps, check({ conversationType: "groupChat" }))).toBe(false);
      await setPersonalBot(s.db, "t1", s.ann.id, false);
      expect(await needsSignIn(s.deps, check())).toBe(false);
    });

    it("only the owner may confirm a personal bot's action; a forwarded card stays pending", async () => {
      const s = await mine();
      await s.say("hi");
      await setRole(s.db, "t1", s.bob.id, "admin");
      const c = new Confirmations();
      for (const kind of ["write", "approve"] as const) {
        const a = c.create({ auditId: "x", mayConfirm: confirmerPolicy(s.db, "t1", s.personal.id, s.ann.id, kind, "c1") });
        await expect(handleConfirmClick(c, { actionId: a.actionId, answer: "yes" }, s.bob.id, "Bob")).resolves.toBe("You can't confirm this.");
        await expect(handleConfirmClick(c, { actionId: a.actionId, answer: "yes" }, s.ann.id, "Ann")).resolves.toBe("Confirmed by Ann");
      }
      const elsewhere = c.create({ auditId: "y", mayConfirm: confirmerPolicy(s.db, "t1", s.personal.id, s.ann.id, "write") });
      await expect(handleConfirmClick(c, { actionId: elsewhere.actionId, answer: "yes" }, s.ann.id, "Ann")).resolves.toBe("You can't confirm this.");
    });
  });

  it("an install in a one-to-one chat sends the card with two usable bots, otherwise the greeting", async () => {
    const s = await chat();
    const install = () => handleInstall(s.deps, { tenantId: "t1", chatId: "c1", conversationType: "personal", from: { aadObjectId: "u1", name: "Ann" } }, s.io);
    await s.service("helper", "Helper");
    await install();
    expect(s.sent).toEqual(["Hi, I'm Bot. Mention me with a question or a job."]);
    await s.service("other", "Other");
    await install();
    expect(s.cards).toHaveLength(1);
    const [c] = await s.db.select().from(chats).where(eq(chats.id, "c1"));
    expect(c.ownerPersonId).toBe(s.ann.id);
  });
});
