import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  openRouterLookupCandidates,
  perTokenToPer1M,
} from "../src/openrouter-models.js";

describe("openrouter pricing convert", () => {
  it("converts per-token USD to per-1M", () => {
    assert.equal(perTokenToPer1M("0.000001"), 1);
    assert.equal(perTokenToPer1M("0.000006"), 6);
    assert.equal(perTokenToPer1M("0"), 0);
    assert.equal(perTokenToPer1M("-1"), 0);
  });

  it("handles cache read scale", () => {
    // 0.0000001 per token → $0.1 / 1M
    assert.equal(perTokenToPer1M("0.0000001"), 0.1);
  });
});

describe("openRouterLookupCandidates", () => {
  it("expands Antigravity Gemini tier aliases", () => {
    const high = openRouterLookupCandidates("gemini-3.6-flash-high");
    assert.ok(high.includes("gemini-3.6-flash-high"));
    assert.ok(high.includes("gemini-3.6-flash"));
    assert.ok(high.includes("google/gemini-3.6-flash"));

    const tiered = openRouterLookupCandidates("gemini-3.6-flash-tiered");
    assert.ok(tiered.includes("gemini-3.6-flash"));

    const proLow = openRouterLookupCandidates("gemini-3.1-pro-low");
    assert.ok(proLow.includes("gemini-3.1-pro"));
    assert.ok(proLow.includes("gemini-3.1-pro-preview"));
    assert.ok(proLow.includes("google/gemini-3.1-pro-preview"));

    const lite = openRouterLookupCandidates("gemini-3.1-flash-lite");
    assert.ok(lite.includes("gemini-3.1-flash-lite"));
    assert.ok(lite.includes("google/gemini-3.1-flash-lite"));
  });
});
