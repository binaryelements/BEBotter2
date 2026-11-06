/**
 * Provider profiles: the only place a vendor's endpoint, model ids, limits and prices live.
 * Adding a provider is a block here, not a new engine.
 *
 * Prices are list prices in USD per million tokens, checked November 2026. They are estimates for
 * the admin screen, not an invoice; confirm them against the provider before relying on them.
 */

export type ModelSpec = {
  id: string;
  contextWindow: number;
  maxOutput: number;
  tools: boolean;
  vision?: boolean;
  pricePerMTok?: { input: number; output: number; cacheRead?: number };
};

export type ProviderProfile = {
  id: string;
  baseUrl: string;
  models: Record<string, ModelSpec>;
  /** Extra body fields for a provider's thinking mode, when it is switched on. */
  thinking?: Record<string, unknown>;
  /** Some providers want max_completion_tokens instead of max_tokens. */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** Whether the provider accepts stream_options.include_usage. */
  includeUsage?: boolean;
};

export const PROVIDERS: Record<string, ProviderProfile> = {
  deepseek: {
    id: "deepseek",
    baseUrl: "https://api.deepseek.com",
    models: {
      "deepseek-flash": { id: "deepseek-flash", contextWindow: 1_000_000, maxOutput: 8_192, tools: true, pricePerMTok: { input: 0.15, output: 0.6, cacheRead: 0.015 } },
      "deepseek-v4-pro": { id: "deepseek-v4-pro", contextWindow: 1_000_000, maxOutput: 8_192, tools: true, pricePerMTok: { input: 2.4, output: 4.8, cacheRead: 0.24 } },
    },
  },
  qwen: {
    id: "qwen",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    models: {
      "qwen3.8-max": { id: "qwen3.8-max", contextWindow: 991_808, maxOutput: 131_072, tools: true, vision: true, pricePerMTok: { input: 2, output: 6, cacheRead: 0.25 } },
      "qwen3.8-flash": { id: "qwen3.8-flash", contextWindow: 991_808, maxOutput: 131_072, tools: true, vision: true, pricePerMTok: { input: 0.15, output: 0.47, cacheRead: 0.016 } },
    },
  },
};

export type ResolvedModel = { slug: string; provider: ProviderProfile; model: ModelSpec };

/** `deepseek/deepseek-flash` → its provider and model; anything else is unknown. */
export function resolveModel(slug: string): ResolvedModel | undefined {
  const slash = slug.indexOf("/");
  if (slash <= 0 || slash === slug.length - 1) return undefined;
  const provider = PROVIDERS[slug.slice(0, slash)];
  const model = provider?.models[slug.slice(slash + 1)];
  return provider && model ? { slug, provider, model } : undefined;
}

export const modelSlugs = (): string[] => Object.entries(PROVIDERS).flatMap(([id, p]) => Object.keys(p.models).map((m) => `${id}/${m}`));

export const contextWindowFor = (slug: string, fallback = 128_000): number => resolveModel(slug)?.model.contextWindow ?? fallback;

export type NormalisedUsage = { inputTokens: number; outputTokens: number; cachedInputTokens?: number };

/** OpenAI-style usage, plus DeepSeek's cache fields. */
export type RawUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number;
};

export function normaliseUsage(raw: RawUsage | undefined): NormalisedUsage {
  const cached = raw?.prompt_tokens_details?.cached_tokens ?? raw?.prompt_cache_hit_tokens;
  return {
    inputTokens: raw?.prompt_tokens ?? 0,
    outputTokens: raw?.completion_tokens ?? 0,
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
  };
}

export function priceFor(model: ModelSpec, usage: NormalisedUsage): number {
  const p = model.pricePerMTok;
  if (!p) return 0;
  const cached = usage.cachedInputTokens ?? 0;
  const fresh = Math.max(0, usage.inputTokens - cached);
  return (fresh * p.input + cached * (p.cacheRead ?? p.input) + usage.outputTokens * p.output) / 1_000_000;
}
