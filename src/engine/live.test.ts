import { afterEach, describe, expect, it, vi } from "vitest";
import type { Options, SDKMessage, SDKResultMessage, SDKUserMessage, query } from "@anthropic-ai/claude-agent-sdk";
import { LiveSessions } from "./live.js";

/** A fake engine: answers each pushed message with a result echoing its text, until `crash` names it. */
function fakeEngine(opts: { crash?: string; endOn?: string; hold?: Promise<void> } = {}) {
  const started: Options[] = [];
  const closed: number[] = [];
  const fn = (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const n = started.push(options) - 1;
    let open = true;
    const gen = (async function* () {
      for await (const m of prompt) {
        if (!open) return;
        const text = m.message.content as string;
        if (text === opts.crash) throw new Error("process died");
        if (text === opts.endOn) return;
        if (text === "slow") await opts.hold;
        yield { type: "assistant", message: { content: [{ type: "text", text: `on ${n}` }] } };
        yield { type: "result", subtype: "success", result: `${text} on ${n}`, session_id: "s", total_cost_usd: 0, is_error: false };
      }
    })();
    return Object.assign(gen, { close: () => void ((open = false), closed.push(n)) });
  }) as unknown as typeof query;
  return { fn, started, closed };
}

const start = (model: string) => () => ({ model }) as Options;
const quiet = () => {};
const said = async (p: Promise<SDKResultMessage>) => {
  const r = await p;
  return r.subtype === "success" ? r.result : r.subtype;
};

afterEach(() => vi.useRealTimers());

describe("LiveSessions", () => {
  it("keeps one process per key and resolves each send with its own result", async () => {
    const e = fakeEngine();
    const live = new LiveSessions(e.fn, { idleMs: 60_000, max: 5 });
    const seen: SDKMessage[] = [];
    expect(await said(live.send("k", "f", start("m"), "one", (m) => void seen.push(m)))).toBe("one on 0");
    expect(await said(live.send("k", "f", start("m"), "two", quiet))).toBe("two on 0");
    expect(e.started).toHaveLength(1);
    expect(seen.map((m) => m.type)).toEqual(["assistant", "result"]);
    await live.closeAll();
    expect(e.closed).toEqual([0]);
  });

  it("a different fingerprint closes the old process and starts a new one", async () => {
    const e = fakeEngine();
    const live = new LiveSessions(e.fn, { idleMs: 60_000, max: 5 });
    await live.send("k", "f1", start("a"), "one", quiet);
    expect(await said(live.send("k", "f2", start("b"), "two", quiet))).toBe("two on 1");
    expect(e.closed).toEqual([0]);
    expect(e.started.map((o) => o.model)).toEqual(["a", "b"]);
  });

  it("closes a process left idle", async () => {
    vi.useFakeTimers();
    const e = fakeEngine();
    const live = new LiveSessions(e.fn, { idleMs: 1000, max: 5 });
    await live.send("k", "f", start("m"), "one", quiet);
    vi.advanceTimersByTime(999);
    expect(e.closed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(e.closed).toEqual([0]);
    await live.send("k", "f", start("m"), "two", quiet);
    expect(e.started).toHaveLength(2);
  });

  it("a running turn is not idle", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const e = fakeEngine({ hold: gate });
    const live = new LiveSessions(e.fn, { idleMs: 1000, max: 5 });
    await live.send("k", "f", start("m"), "one", quiet);
    const slow = live.send("k", "f", start("m"), "slow", quiet);
    vi.advanceTimersByTime(5000);
    expect(e.closed).toEqual([]);
    release();
    expect(await said(slow)).toBe("slow on 0");
    vi.advanceTimersByTime(1000);
    expect(e.closed).toEqual([0]);
  });

  it("evicts the least recently used idle process past max", async () => {
    const e = fakeEngine();
    const live = new LiveSessions(e.fn, { idleMs: 60_000, max: 2 });
    await live.send("a", "f", start("m"), "x", quiet);
    await live.send("b", "f", start("m"), "x", quiet);
    await live.send("a", "f", start("m"), "x", quiet); // a is now the most recent
    await live.send("c", "f", start("m"), "x", quiet);
    expect(e.closed).toEqual([1]);
    await live.send("a", "f", start("m"), "x", quiet);
    expect(e.started).toHaveLength(3);
  });

  it("never evicts a process whose turn is running", async () => {
    let release!: () => void;
    const e = fakeEngine({ hold: new Promise<void>((r) => (release = r)) });
    const live = new LiveSessions(e.fn, { idleMs: 60_000, max: 1 });
    const slow = live.send("a", "f", start("m"), "slow", quiet);
    await live.send("b", "f", start("m"), "x", quiet);
    expect(e.closed).toEqual([]);
    release();
    expect(await said(slow)).toBe("slow on 0");
    await live.send("c", "f", start("m"), "x", quiet);
    expect(e.closed).toEqual([0, 1]);
  });

  it("warm starts a process that the next send on its key and fingerprint uses", async () => {
    const e = fakeEngine();
    const live = new LiveSessions(e.fn, { idleMs: 60_000, max: 5 });
    live.warm("k", "f", start("m"));
    expect(e.started).toHaveLength(1);
    expect(await said(live.send("k", "f", start("m"), "one", quiet))).toBe("one on 0");
    expect(e.started).toHaveLength(1);
  });

  it("warm on a key that is already live does nothing", async () => {
    const e = fakeEngine();
    const live = new LiveSessions(e.fn, { idleMs: 60_000, max: 5 });
    await live.send("k", "f", start("m"), "one", quiet);
    live.warm("k", "f2", start("other"));
    live.warm("k", "f", start("m"));
    expect(e.started).toHaveLength(1);
    expect(e.closed).toEqual([]);
  });

  it("a warmed process idles out and counts toward max", async () => {
    vi.useFakeTimers();
    const e = fakeEngine();
    const live = new LiveSessions(e.fn, { idleMs: 1000, max: 1 });
    live.warm("a", "f", start("m"));
    live.warm("b", "f", start("m"));
    expect(e.closed).toEqual([0]);
    vi.advanceTimersByTime(1000);
    expect(e.closed).toEqual([0, 1]);
  });

  it.each([["throws", { crash: "boom" }], ["ends", { endOn: "boom" }]])("a stream that %s mid-turn rejects and the next send starts fresh", async (_, opts) => {
    const e = fakeEngine(opts);
    const live = new LiveSessions(e.fn, { idleMs: 60_000, max: 5 });
    await live.send("k", "f", start("m"), "one", quiet);
    await expect(live.send("k", "f", start("m"), "boom", quiet)).rejects.toThrow();
    expect(e.closed).toEqual([0]);
    expect(await said(live.send("k", "f", start("m"), "two", quiet))).toBe("two on 1");
  });
});
