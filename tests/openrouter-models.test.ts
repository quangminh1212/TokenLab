import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { perTokenToPer1M } from "./openrouter-models.js";

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
