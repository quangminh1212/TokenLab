import assert from "node:assert/strict";
import { test } from "node:test";
import { extractModel, extractTokenBuckets } from "./usage-fields.js";

test("extractTokenBuckets reads anthropic-style usage", () => {
  const b = extractTokenBuckets({
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 1,
  });
  assert.deepEqual(b, {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
  });
});

test("extractTokenBuckets reads nested usage", () => {
  const b = extractTokenBuckets({ usage: { prompt_tokens: 3, completion_tokens: 4 } });
  assert.equal(b?.inputTokens, 3);
  assert.equal(b?.outputTokens, 4);
});

test("extractModel prefers modelId", () => {
  assert.equal(extractModel({ modelId: "grok-4.5" }), "grok-4.5");
});
