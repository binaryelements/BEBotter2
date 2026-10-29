import { afterEach, describe, expect, it, vi } from "vitest";
import { Confirmations } from "./confirm.js";

const make = () => {
  const c = new Confirmations(setTimeout);
  const { actionId, outcome } = c.create({ auditId: "a1", askerPersonId: "alice" });
  return { c, actionId, outcome };
};

describe("Confirmations", () => {
  afterEach(() => vi.useRealTimers());

  it("confirms when the asker says yes, once", async () => {
    const { c, actionId, outcome } = make();
    expect(c.resolve(actionId, "alice", "yes")).toBe("confirmed");
    await expect(outcome).resolves.toBe("confirmed");
    expect(c.resolve(actionId, "alice", "yes")).toBe("unknown");
  });

  it("rejects another person and stays pending", async () => {
    const { c, actionId, outcome } = make();
    let settled = false;
    void outcome.then(() => (settled = true));
    expect(c.resolve(actionId, "bob", "yes")).toBe("not_allowed");
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(c.resolve(actionId, "alice", "no")).toBe("denied");
  });

  it("denies when the asker says no", async () => {
    const { c, actionId, outcome } = make();
    expect(c.resolve(actionId, "alice", "no")).toBe("denied");
    await expect(outcome).resolves.toBe("denied");
  });

  it("expires after the ttl", async () => {
    vi.useFakeTimers();
    const { c, actionId, outcome } = make();
    vi.advanceTimersByTime(600_000);
    await expect(outcome).resolves.toBe("expired");
    expect(c.resolve(actionId, "alice", "yes")).toBe("unknown");
  });
});
