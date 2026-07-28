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
