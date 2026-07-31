import assert from "node:assert/strict";
import { test } from "node:test";
import { priceCostParts, priceTokens, resolveModelKey } from "../src/pricing.js";

test("resolveModelKey maps claude sonnet aliases", () => {
  assert.equal(resolveModelKey("claude-sonnet-4-20250514"), "claude-sonnet-4");
  assert.equal(resolveModelKey("grok-4.5"), "grok-4.5");
});

test("priceTokens computes positive cost", () => {
  const r = priceTokens("claude-sonnet-4", 1_000_000, 0, 0, 0);
  assert.equal(r.pricingStatus, "priced");
  assert.ok(r.estimatedCost != null && r.estimatedCost > 0);
  assert.equal(r.estimatedCost, 3);
});

test("priceCostParts uses cheaper cache read rate (not input rate)", () => {
  // claude-sonnet-4: in $3, out $15, cache read $0.3, cache write $3.75 per 1M
  const p = priceCostParts("claude-sonnet-4", 1_000_000, 0, 1_000_000, 0);
  assert.equal(p.inputCost, 3);
  assert.equal(p.cacheCost, 0.3);
  assert.equal(p.outputCost, 0);
  assert.equal(p.tableTotal, 3.3);
  // Token-share would give cache half of total ($1.65) — must NOT match that
  assert.ok(Math.abs(p.cacheCost - 1.65) > 0.5);
});

test("priceCostParts scales to router actual total keeping rate ratios", () => {
  const p = priceCostParts("claude-sonnet-4", 1_000_000, 0, 1_000_000, 0, 6.6);
  assert.ok(Math.abs(p.inputCost - 6) < 1e-9);
  assert.ok(Math.abs(p.cacheCost - 0.6) < 1e-9);
});

test("unknown model falls back to default rates", () => {
  const r = priceTokens("totally-unknown-model-xyz", 1_000_000, 0);
  assert.equal(r.pricingStatus, "unknown_model");
  assert.ok((r.estimatedCost || 0) > 0);
  assert.ok(r.estimatedCost != null && r.estimatedCost > 0);
});

test("grok-4.5 uses official short cache $0.30 and 2x long context ≥200k", () => {
  // Short: uncached 20k @ $2 + out 2k @ $6 + cache 80k @ $0.30
  const short = priceTokens("grok-4.5", 20_000, 2_000, 80_000, 0);
  assert.ok(Math.abs((short.estimatedCost ?? 0) - (20_000 * 2 + 2_000 * 6 + 80_000 * 0.3) / 1e6) < 1e-12);

  // Long: prompt 250k (50k uncached + 200k cache) → 2× rates
  const long = priceTokens("grok-4.5", 50_000, 1_000, 200_000, 0);
  const expected = (50_000 * 4 + 1_000 * 12 + 200_000 * 0.6) / 1e6;
  assert.ok(Math.abs((long.estimatedCost ?? 0) - expected) < 1e-12);
});

test("router models qwen3-coder-next / step-3.7-flash / laguna-s-2.1 resolve with OR rates", () => {
  assert.equal(resolveModelKey("qwen3-coder-next"), "qwen3-coder-next");
  assert.equal(resolveModelKey("qwen/qwen3-coder-next"), "qwen3-coder-next");
  assert.equal(resolveModelKey("step-3.7-flash"), "step-3.7-flash");
  assert.equal(resolveModelKey("stepfun/step-3.7-flash"), "step-3.7-flash");
  assert.equal(resolveModelKey("laguna-s-2.1"), "laguna-s-2.1");
  assert.equal(resolveModelKey("poolside/laguna-s-2.1"), "laguna-s-2.1");
  assert.equal(resolveModelKey("minimax-m2.7"), "minimax-m2.7");
  assert.equal(resolveModelKey("deepseek-v4-flash"), "deepseek-v4-flash");

  // 1M in + 1M out at bundled rates
  assert.equal(priceTokens("qwen3-coder-next", 1_000_000, 1_000_000).estimatedCost, 0.18 + 0.9);
  assert.equal(priceTokens("step-3.7-flash", 1_000_000, 1_000_000).estimatedCost, 0.2 + 1.15);
  assert.equal(priceTokens("laguna-s-2.1", 1_000_000, 1_000_000).estimatedCost, 0.1 + 0.2);
  assert.equal(priceTokens("minimax-m3", 1_000_000, 1_000_000).estimatedCost, 0.3 + 1.2);
  assert.equal(priceTokens("deepseek-v4-flash", 1_000_000, 1_000_000).estimatedCost, 0.14 + 0.28);
});

test("getRateForModel prefers OpenRouter over bundled Gemini family fallback", async () => {
  const { loadOpenRouterCacheFromDisk, lookupOpenRouterRate } = await import(
    "../src/openrouter-models.js"
  );
  const { getRateForModel } = await import("../src/pricing.js");
  await loadOpenRouterCacheFromDisk();

  // Skip if catalog not on disk (CI without cache)
  const orFlash = lookupOpenRouterRate("google/gemini-3.6-flash");
  if (!orFlash) return;

  const high = getRateForModel("gemini-3.6-flash-high");
  assert.equal(high.source, "openrouter");
  assert.ok(high.key?.includes("gemini-3.6-flash"));
  assert.equal(high.rate.inputPer1M, orFlash.rate.inputPer1M);
  assert.equal(high.rate.outputPer1M, orFlash.rate.outputPer1M);

  const tiered = getRateForModel("gemini-3.6-flash-tiered");
  assert.equal(tiered.source, "openrouter");
  assert.equal(tiered.rate.inputPer1M, orFlash.rate.inputPer1M);

  const lite = getRateForModel("gemini-3.1-flash-lite");
  const orLite = lookupOpenRouterRate("google/gemini-3.1-flash-lite");
  if (orLite) {
    assert.equal(lite.source, "openrouter");
    assert.equal(lite.rate.inputPer1M, orLite.rate.inputPer1M);
  }

  const proLow = getRateForModel("gemini-3.1-pro-low");
  const orPro = lookupOpenRouterRate("google/gemini-3.1-pro-preview");
  if (orPro) {
    assert.equal(proLow.source, "openrouter");
    assert.equal(proLow.rate.inputPer1M, orPro.rate.inputPer1M);
  }
});
