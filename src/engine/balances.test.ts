import { describe, expect, it, vi } from "vitest";
import { deepseekBalance } from "./balances.js";

describe("deepseek balance", () => {
  it("reads the total balance and caches it", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "6.82", granted_balance: "0.00", topped_up_balance: "6.82" }] }), { status: 200 }),
    );
    const read = deepseekBalance("key", fetchFn as unknown as typeof fetch);
    const a = await read();
    expect(a).toMatchObject({ provider: "deepseek", available: true, currency: "USD", total: 6.82, toppedUp: 6.82 });
    expect(await read()).toEqual(a);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("reports an error without throwing", async () => {
    const fetchFn = vi.fn(async () => new Response("no", { status: 401 }));
    const read = deepseekBalance("key", fetchFn as unknown as typeof fetch);
    expect(await read()).toMatchObject({ available: false, error: "HTTP 401" });
  });

  it("returns nothing without a key", async () => {
    expect(await deepseekBalance("")()).toBeUndefined();
  });
});
