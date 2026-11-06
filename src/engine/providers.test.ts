import { describe, expect, it } from "vitest";
import { contextWindowFor, modelSlugs, normaliseUsage, priceFor, resolveModel } from "./providers.js";

describe("providers", () => {
  it("resolves a provider/model slug", () => {
    const r = resolveModel("deepseek/deepseek-flash");
    expect(r?.provider.id).toBe("deepseek");
    expect(r?.model.id).toBe("deepseek-flash");
    expect(resolveModel("qwen/qwen3.8-max")?.model.contextWindow).toBeGreaterThan(900_000);
    expect(resolveModel("nope")).toBeUndefined();
    expect(resolveModel("deepseek/nope")).toBeUndefined();
    expect(resolveModel("deepseek/")).toBeUndefined();
  });

  it("lists every model as provider/model", () => {
    expect(modelSlugs()).toEqual(expect.arrayContaining(["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro", "qwen/qwen3.8-max", "qwen/qwen3.8-flash"]));
  });

  it("normalises OpenAI and DeepSeek usage", () => {
    expect(normaliseUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } })).toEqual({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 });
    expect(normaliseUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 6 })).toEqual({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 6 });
    expect(normaliseUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("prices fresh, cached and output tokens", () => {
    const model = resolveModel("deepseek/deepseek-flash")!.model;
    expect(priceFor(model, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(0.75, 6);
    expect(priceFor(model, { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 })).toBeCloseTo(0.015, 6);
  });

  it("falls back to a conservative context window", () => {
    expect(contextWindowFor("nope/nope")).toBe(128_000);
    expect(contextWindowFor("deepseek/deepseek-flash")).toBe(1_000_000);
  });
});
