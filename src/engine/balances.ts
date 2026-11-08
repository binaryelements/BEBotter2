/**
 * What is left with the model providers. DeepSeek exposes a read-only balance endpoint;
 * the result is cached so the dashboard does not call it on every page load.
 */

export type ProviderBalance = {
  provider: "deepseek";
  available: boolean;
  currency: string;
  total: number;
  granted: number;
  toppedUp: number;
  checkedAt: Date;
  error?: string;
};

export type BalanceReader = () => Promise<ProviderBalance | undefined>;

const CACHE_MS = 5 * 60_000;
const TIMEOUT_MS = 3_000;

export function deepseekBalance(apiKey: string, fetchFn: typeof fetch = fetch): BalanceReader {
  let cache: { at: number; value: ProviderBalance } | undefined;
  return async () => {
    if (!apiKey) return undefined;
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
    try {
      const res = await fetchFn("https://api.deepseek.com/user/balance", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const value: ProviderBalance = { provider: "deepseek", available: false, currency: "USD", total: 0, granted: 0, toppedUp: 0, checkedAt: new Date(), error: `HTTP ${res.status}` };
        cache = { at: Date.now(), value };
        return value;
      }
      const body = (await res.json()) as { is_available?: boolean; balance_infos?: { currency?: string; total_balance?: string; granted_balance?: string; topped_up_balance?: string }[] };
      const info = body.balance_infos?.[0];
      const value: ProviderBalance = {
        provider: "deepseek",
        available: !!body.is_available,
        currency: info?.currency ?? "USD",
        total: Number(info?.total_balance ?? 0),
        granted: Number(info?.granted_balance ?? 0),
        toppedUp: Number(info?.topped_up_balance ?? 0),
        checkedAt: new Date(),
      };
      cache = { at: Date.now(), value };
      return value;
    } catch (e) {
      const value: ProviderBalance = { provider: "deepseek", available: false, currency: "USD", total: 0, granted: 0, toppedUp: 0, checkedAt: new Date(), error: e instanceof Error ? e.message : "unknown" };
      cache = { at: Date.now(), value };
      return value;
    }
  };
}
