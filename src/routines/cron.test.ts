import { describe, expect, it } from "vitest";
import { cronMatches, parseCron } from "./cron.js";

const m = (expr: string, iso: string, tz = "UTC") => cronMatches(parseCron(expr), new Date(iso), tz);

describe("cron", () => {
  it("matches the standard examples", () => {
    expect(m("0 7 * * 1-5", "2026-10-26T07:00:00Z")).toBe(true); // Monday
    expect(m("0 7 * * 1-5", "2026-10-31T07:00:00Z")).toBe(false); // Saturday
    expect(m("0 7 * * 1-5", "2026-10-26T07:01:00Z")).toBe(false);
    expect(m("*/15 * * * *", "2026-10-26T10:45:00Z")).toBe(true);
    expect(m("*/15 * * * *", "2026-10-26T10:50:00Z")).toBe(false);
    expect(m("0 0 1 * *", "2026-11-01T00:00:00Z")).toBe(true);
    expect(m("0 0 1 * *", "2026-11-02T00:00:00Z")).toBe(false);
    expect(m("30 2 * * 0", "2026-11-01T02:30:00Z")).toBe(true); // Sunday
    expect(m("30 2 * * 7", "2026-11-01T02:30:00Z")).toBe(true);
    expect(m("10-20/5 * * * *", "2026-10-26T10:15:00Z")).toBe(true);
    expect(m("0 0 1,15 * 1", "2026-10-26T00:00:00Z")).toBe(true); // either day field
  });
  it("evaluates in the tenant time zone", () => {
    expect(m("0 7 * * *", "2026-10-29T20:00:00Z", "Australia/Sydney")).toBe(true);
    expect(m("0 7 * * *", "2026-10-29T20:00:00Z", "UTC")).toBe(false);
  });
  it("rejects malformed expressions", () => {
    for (const bad of ["* * *", "60 * * * *", "a b c d e", "*/0 * * * *", "5-2 * * * *"]) expect(() => parseCron(bad)).toThrow();
  });
});
