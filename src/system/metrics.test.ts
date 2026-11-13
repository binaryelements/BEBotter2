import { describe, expect, it } from "vitest";
import { cpuBetween, parseCpu, parseMem } from "./metrics.js";

describe("host metrics", () => {
  it("reads idle and total from the first cpu line of /proc/stat", () => {
    expect(parseCpu("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3 4")).toEqual({ idle: 850, total: 1000 });
    expect(parseCpu("intr 1 2\n")).toBeUndefined();
    expect(parseCpu("cpu 1 2")).toBeUndefined();
  });

  it("turns two readings into busy percent, and refuses a backwards clock", () => {
    expect(cpuBetween({ idle: 850, total: 1000 }, { idle: 900, total: 1100 })).toBe(50);
    expect(cpuBetween(undefined, { idle: 1, total: 2 })).toBeNull();
    expect(cpuBetween({ idle: 10, total: 100 }, { idle: 5, total: 100 })).toBeNull();
  });

  it("reads memory in kB, preferring MemAvailable and falling back to free+buffers+cached", () => {
    expect(parseMem("MemTotal: 8000000 kB\nMemFree: 1000000 kB\nMemAvailable: 6000000 kB")).toEqual({ used: 2000000, total: 8000000 });
    expect(parseMem("MemTotal: 100 kB\nMemFree: 10 kB\nBuffers: 5 kB\nCached: 5 kB")).toEqual({ used: 80, total: 100 });
    expect(parseMem("nothing useful")).toBeUndefined();
  });
});
