import assert from "node:assert/strict";
import { test } from "node:test";
import { priceTokens, resolveModelKey } from "./pricing.js";

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

test("unknown model returns null cost", () => {
  const r = priceTokens("totally-unknown-model-xyz", 100, 100);
  assert.equal(r.pricingStatus, "unknown_model");
  assert.equal(r.estimatedCost, null);
});
