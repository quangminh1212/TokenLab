import assert from "node:assert/strict";
import { test } from "node:test";
import { extractModel, extractTokenBuckets } from "../src/agents/shared/usage-fields.js";

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

test("extractTokenBuckets reads Devin-style metadata.metrics", () => {
  const b = extractTokenBuckets({
    role: "assistant",
    metadata: {
      metrics: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 50,
      },
    },
  });
  assert.equal(b?.inputTokens, 100);
  assert.equal(b?.outputTokens, 20);
  assert.equal(b?.cacheReadTokens, 50);
});

test("extractTokenBuckets reads cached_tokens and prompt_tokens_details", () => {
  const flat = extractTokenBuckets({
    prompt_tokens: 1000,
    completion_tokens: 20,
    cached_tokens: 800,
  });
  assert.equal(flat?.cacheReadTokens, 800);
  assert.equal(flat?.inputTokens, 1000);

  const nested = extractTokenBuckets({
    usage: {
      prompt_tokens: 500,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 400 },
    },
  });
  assert.equal(nested?.inputTokens, 500);
  assert.equal(nested?.cacheReadTokens, 400);
});
