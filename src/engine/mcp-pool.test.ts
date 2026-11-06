import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpPool } from "./mcp-pool.js";

type Fake = { close: ReturnType<typeof vi.fn> };
const client = (): Fake & Client => ({ close: vi.fn(async () => {}) }) as unknown as Fake & Client;

afterEach(() => vi.useRealTimers());

describe("McpPool", () => {
  it("connects once and reuses the client", async () => {
    const pool = new McpPool({ idleMs: 60_000, max: 5 });
    const c = client();
    const connect = vi.fn(async () => c);
    expect(await pool.acquire("k", connect)).toBe(c);
    pool.release("k");
    expect(await pool.acquire("k", connect)).toBe(c);
    expect(connect).toHaveBeenCalledTimes(1);
    await pool.close();
  });

  it("drops an idle client after the idle time", async () => {
    vi.useFakeTimers();
    const pool = new McpPool({ idleMs: 1_000, max: 5 });
    const c = client();
    await pool.acquire("k", async () => c);
    pool.release("k");
    vi.advanceTimersByTime(999);
    expect(c.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(c.close).toHaveBeenCalledTimes(1);
    await pool.close();
  });

  it("evicts the least recently used idle client past max", async () => {
    const pool = new McpPool({ idleMs: 60_000, max: 2 });
    const a = client();
    const b = client();
    const c = client();
    await pool.acquire("a", async () => a);
    pool.release("a");
    await pool.acquire("b", async () => b);
    pool.release("b");
    await pool.acquire("a", async () => a); // a is now the most recent
    pool.release("a");
    await pool.acquire("c", async () => c);
    pool.release("c");
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(a.close).not.toHaveBeenCalled();
    await pool.close();
  });

  it("never evicts a busy client", async () => {
    const pool = new McpPool({ idleMs: 60_000, max: 1 });
    const a = client();
    const b = client();
    await pool.acquire("a", async () => a); // busy
    await pool.acquire("b", async () => b);
    pool.release("b");
    expect(a.close).not.toHaveBeenCalled();
    await pool.close();
  });

  it("closes every client", async () => {
    const pool = new McpPool({ idleMs: 60_000, max: 5 });
    const a = client();
    const b = client();
    await pool.acquire("a", async () => a);
    await pool.acquire("b", async () => b);
    await pool.close();
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).toHaveBeenCalledTimes(1);
  });
});
