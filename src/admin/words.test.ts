import { describe, expect, it } from "vitest";
import { capabilityWords, chatTypeWords, cronWords, inputWords, whenIn } from "./words.js";

describe("words", () => {
  it("says times in the company zone relative to today", () => {
    const now = new Date("2026-11-04T02:00:00Z"); // Wed 4 Nov, 1:00 pm in Melbourne
    const when = whenIn("Australia/Melbourne", now);
    expect(when(new Date("2026-11-04T01:30:00Z"))).toBe("today 12:30 pm");
    expect(when(new Date("2026-11-03T06:05:00Z"))).toBe("yesterday 5:05 pm");
    expect(when(new Date("2026-10-27T22:00:00Z"))).toBe("Wed 28 Oct, 9:00 am");
    expect(when(new Date("2025-11-03T22:00:00Z"))).toBe("4 Nov 2025");
    expect(when(null)).toBe("");
  });

  it("says common schedules in words and leaves the rest as written", () => {
    expect(cronWords("0 8 * * 1-5")).toBe("weekdays 8:00 am");
    expect(cronWords("30 18 * * *")).toBe("every day 6:30 pm");
    expect(cronWords("0 9 * * 1")).toBe("Mondays 9:00 am");
    expect(cronWords("15 7 * * 2,4")).toBe("Tue, Thu 7:15 am");
    expect(cronWords("0 0 1 * *")).toBe("0 0 1 * *");
    expect(cronWords("*/5 * * * *")).toBe("*/5 * * * *");
    expect(cronWords("nonsense")).toBe("nonsense");
  });

  it("turns codes into words", () => {
    expect(capabilityWords("mail.read")).toBe("read mail");
    expect(capabilityWords("sites.read")).toBe("sites read");
    expect(chatTypeWords("groupChat")).toBe("group");
    expect(chatTypeWords("personal")).toBe("one-to-one");
    expect(inputWords('list-invoices {"page":3,"status":"AUTHORISED"}')).toBe("list invoices: page 3 · status AUTHORISED");
    expect(inputWords("search {}")).toBe("search");
    expect(inputWords("pve1: uptime")).toBe("pve1: uptime");
    expect(inputWords('list-invoices {"page":3,"inv')).toBe('list-invoices {"page":3,"inv');
  });
});
