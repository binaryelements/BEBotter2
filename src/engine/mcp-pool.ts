import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type Entry = { client: Client; timer?: NodeJS.Timeout; busy: boolean };

/**
 * Keeps stdio MCP clients alive between turns. A browser client is keyed per chat, so its in-memory
 * profile and cookies never reach another chat; a stateless server may be keyed per definition.
 */
export class McpPool {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly opts: { idleMs: number; max: number }) {}

  async acquire(key: string, connect: () => Promise<Client>): Promise<Client> {
    const existing = this.entries.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.timer = undefined;
      existing.busy = true;
      this.entries.delete(key);
      this.entries.set(key, existing); // insertion order is recency
      return existing.client;
    }
    const client = await connect();
    this.entries.set(key, { client, busy: true });
    this.evict();
    return client;
  }

  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.busy = false;
    if (Number.isFinite(this.opts.idleMs)) entry.timer = setTimeout(() => void this.drop(key), this.opts.idleMs).unref();
  }

  async close(): Promise<void> {
    for (const key of [...this.entries.keys()]) await this.drop(key);
  }

  private async drop(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    clearTimeout(entry.timer);
    await entry.client.close().catch((err) => console.error("closing a pooled MCP client failed", err instanceof Error ? err.name : "unknown"));
  }

  // a running turn is never evicted, so the pool may exceed max while every client is busy
  private evict(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.opts.max) return;
      if (!entry.busy) void this.drop(key);
    }
  }
}
