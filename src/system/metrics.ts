import { randomUUID } from "node:crypto";
import { lt } from "drizzle-orm";
import { readFileSync } from "node:fs";
import type { Db } from "../db/client.js";
import { resourceSamples } from "../db/schema.js";

/** One host sample: CPU busy % since the previous one, and memory in kB. */
export type HostSample = { cpuPct: number | null; memUsed: number; memTotal: number };

type CpuCounters = { idle: number; total: number };

/** The first `cpu` line of /proc/stat: idle (with iowait) and every field's sum. */
export function parseCpu(stat: string): CpuCounters | undefined {
  const line = stat.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return undefined;
  const n = line.trim().split(/\s+/).slice(1).map(Number);
  if (n.length < 4 || n.some((x) => !Number.isFinite(x))) return undefined;
  const idle = n[3]! + (n[4] ?? 0);
  return { idle, total: n.slice(0, 8).reduce((a, b) => a + (b || 0), 0) };
}

/** Busy % between two readings; null when no time passed (or the counters went backwards). */
export function cpuBetween(prev: CpuCounters | undefined, next: CpuCounters | undefined): number | null {
  if (!prev || !next) return null;
  const dt = next.total - prev.total;
  const di = next.idle - prev.idle;
  if (dt <= 0 || di < 0) return null;
  return Math.max(0, Math.min(100, 100 * (1 - di / dt)));
}

/** MemTotal and MemAvailable (kB), falling back to free+buffers+cached. */
export function parseMem(info: string): { used: number; total: number } | undefined {
  const kb = (key: string): number | undefined => {
    const m = info.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
    return m ? Number(m[1]) : undefined;
  };
  const total = kb("MemTotal");
  if (!total) return undefined;
  const available = kb("MemAvailable") ?? ((kb("MemFree") ?? 0) + (kb("Buffers") ?? 0) + (kb("Cached") ?? 0) || undefined);
  return available === undefined ? undefined : { used: Math.max(0, total - available), total };
}

const read = (path: string) => readFileSync(path, "utf8");

export function hostSample(prev: CpuCounters | undefined, now: CpuCounters | undefined): HostSample | undefined {
  let mem: { used: number; total: number } | undefined;
  try {
    mem = parseMem(read("/proc/meminfo"));
  } catch {
    mem = undefined;
  }
  if (!mem) return undefined;
  return { cpuPct: cpuBetween(prev, now), memUsed: mem.used, memTotal: mem.total };
}

export const cpuNow = (): CpuCounters | undefined => {
  try {
    return parseCpu(read("/proc/stat"));
  } catch {
    return undefined;
  }
};

const KEEP_MS = 7 * 24 * 3600_000;

/**
 * Samples the host once a minute and keeps a week: enough to see a trend when chats and bots grow. Host-wide on
 * Docker (the container sees the host's /proc), so it shows what the box is doing, not just this process.
 */
export function startMetrics(db: Db, intervalMs = 60_000, now: () => Date = () => new Date()): () => void {
  let prev = cpuNow();
  const tick = async () => {
    const cur = cpuNow();
    const sample = hostSample(prev, cur);
    prev = cur;
    // the first reading has nothing to compare with; it only sets the baseline
    if (!sample || sample.cpuPct === null) return;
    try {
      await db.insert(resourceSamples).values({ id: randomUUID(), at: now(), cpuPct: sample.cpuPct, memUsed: sample.memUsed, memTotal: sample.memTotal });
      await db.delete(resourceSamples).where(lt(resourceSamples.at, new Date(now().getTime() - KEEP_MS)));
    } catch (e) {
      console.error("metrics:", e instanceof Error ? e.message : "error");
    }
  };
  const timer = setInterval(() => void tick(), intervalMs).unref();
  return () => clearInterval(timer);
}
