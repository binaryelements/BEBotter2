import type { Options, Query, SDKMessage, SDKResultMessage, SDKUserMessage, query } from "@anthropic-ai/claude-agent-sdk";

type Live = { q: Query; it: AsyncIterator<SDKMessage>; push: (m: SDKUserMessage) => void; end: () => void; fingerprint: string; busy: boolean; spent: number; timer?: NodeJS.Timeout };

/** A prompt the SDK reads one user message at a time, for as long as the process lives. */
function inbox() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const poke = () => {
    wake?.();
    wake = undefined;
  };
  const iterable: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (ended) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
  return { iterable, push: (m: SDKUserMessage) => void (queue.push(m), poke()), end: () => void ((ended = true), poke()) };
}

/** One Agent SDK process per key, kept between turns so a turn does not pay the engine's startup. Turns on one key must not overlap. */
export class LiveSessions {
  // insertion order is recency: the first entry is the least recently used
  private live = new Map<string, Live>();

  constructor(
    private queryFn: typeof query,
    private opts: { idleMs: number; max: number },
  ) {}

  /**
   * Sends one user message and resolves with its result, whose total_cost_usd is this turn's cost (the process reports a running total).
   * A different fingerprint replaces the process; a failed turn closes it.
   */
  async send(key: string, fingerprint: string, start: () => Options, text: string, onMessage: (m: SDKMessage) => void): Promise<SDKResultMessage> {
    let s = this.live.get(key);
    if (s && s.fingerprint !== fingerprint) {
      this.close(key);
      s = undefined;
    }
    if (!s) {
      const box = inbox();
      const q = this.queryFn({ prompt: box.iterable, options: start() });
      s = { q, it: q[Symbol.asyncIterator](), push: box.push, end: box.end, fingerprint, busy: false, spent: 0 };
    }
    const live = s;
    clearTimeout(live.timer);
    this.live.delete(key);
    this.live.set(key, live);
    live.busy = true;
    this.evict();
    try {
      live.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
      for (;;) {
        const { value, done } = await live.it.next();
        if (done) throw new Error("engine process ended mid-turn");
        onMessage(value);
        if (value.type === "result") {
          const cost = value.total_cost_usd - live.spent;
          live.spent = value.total_cost_usd;
          return { ...value, total_cost_usd: cost };
        }
      }
    } catch (err) {
      this.drop(key, live);
      throw err;
    } finally {
      live.busy = false;
      // a turn waiting on a confirmation is busy, so only the time after it counts as idle
      if (this.live.get(key) === live) live.timer = setTimeout(() => this.drop(key, live), this.opts.idleMs).unref();
    }
  }

  close(key: string): void {
    const s = this.live.get(key);
    if (s) this.drop(key, s);
  }

  async closeAll(): Promise<void> {
    for (const key of [...this.live.keys()]) this.close(key);
  }

  private drop(key: string, s: Live): void {
    if (this.live.get(key) !== s) return; // already replaced
    this.live.delete(key);
    clearTimeout(s.timer);
    s.end();
    try {
      s.q.close();
    } catch (err) {
      console.error("closing an engine process failed", err instanceof Error ? err.name : "unknown");
    }
  }

  // a running turn is never evicted, so the pool may exceed max while every process is busy
  private evict(): void {
    for (const [key, s] of this.live) {
      if (this.live.size <= this.opts.max) return;
      if (!s.busy) this.drop(key, s);
    }
  }
}
