import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Confirmations } from "./confirm.js";

const make = (allowed = ["alice"]) => {
  const c = new Confirmations(setTimeout);
  const { actionId, outcome } = c.create({ auditId: "a1", mayConfirm: async (p) => allowed.includes(p) });
  return { c, actionId, outcome };
};

describe("Confirmations", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("an allowed clicker confirms and the outcome names them", async () => {
    const { c, actionId, outcome } = make(["alice", "boss"]);
    await expect(c.resolve(actionId, "boss", "yes")).resolves.toBe("confirmed");
    await expect(outcome).resolves.toEqual({ result: "confirmed", personId: "boss" });
    // a second delivery of the same click answers the same way, and only for a while
    await expect(c.resolve(actionId, "boss", "yes")).resolves.toBe("confirmed");
    vi.advanceTimersByTime(600_001);
    await expect(c.resolve(actionId, "boss", "yes")).resolves.toBe("unknown");
  });

  it("a clicker the policy refuses gets not_allowed and the action stays pending", async () => {
    const { c, actionId, outcome } = make();
    let settled = false;
    void outcome.then(() => (settled = true));
    await expect(c.resolve(actionId, "bob", "yes")).resolves.toBe("not_allowed");
    await Promise.resolve();
    expect(settled).toBe(false);
    await expect(c.resolve(actionId, "alice", "no")).resolves.toBe("denied");
  });

  it("denies when an allowed clicker says no", async () => {
    const { c, actionId, outcome } = make();
    await expect(c.resolve(actionId, "alice", "no")).resolves.toBe("denied");
    await expect(outcome).resolves.toEqual({ result: "denied" });
  });

  it("expires after the ttl", async () => {
    const { c, actionId, outcome } = make();
    vi.advanceTimersByTime(600_000);
    await expect(outcome).resolves.toEqual({ result: "expired" });
    await expect(c.resolve(actionId, "alice", "yes")).resolves.toBe("unknown");
  });
});
