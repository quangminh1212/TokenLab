import assert from "node:assert/strict";
import { test } from "node:test";
import { extractModel, extractTokenBuckets, resolveSpanMs, splitRequestsOverSpan } from "../src/agents/shared/usage-fields.js";

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
    // The row carried cache keys, so the extractor measured cache.
    cacheReported: true,
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

test("cacheReported distinguishes a measured zero from a silent cache field", () => {
  // A cache key present with value 0 is a MEASUREMENT: the provider told us
  // cache was zero. The dashboard renders that as a real $0.00, not "—".
  const measuredZero = extractTokenBuckets({
    input_tokens: 100,
    output_tokens: 20,
    cached_tokens: 0,
  });
  assert.equal(measuredZero?.cacheReadTokens, 0);
  assert.equal(measuredZero?.cacheReported, true);

  // No cache key at all is SILENCE: the provider never mentioned cache, so the
  // column must stay "—" rather than implying it measured nothing.
  const silent = extractTokenBuckets({ input_tokens: 100, output_tokens: 20 });
  assert.equal(silent?.cacheReadTokens, 0);
  assert.equal(silent?.cacheReported, undefined);

  // A nonzero cache read is reported regardless of the key spelling used.
  const nonzero = extractTokenBuckets({
    input_tokens: 100,
    output_tokens: 20,
    cache_read_tokens: 60,
  });
  assert.equal(nonzero?.cacheReported, true);
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

test("extractTokenBuckets reads Orca full-input cache fields", () => {
  const b = extractTokenBuckets({
    input_tokens: 1_000,
    cached_input_tokens: 800,
    cache_write_input_tokens: 50,
    reasoning_output_tokens: 7,
  });
  assert.deepEqual(b, {
    inputTokens: 1_000,
    outputTokens: 7,
    cacheReadTokens: 800,
    cacheWriteTokens: 50,
    inputIncludesCache: true,
    cacheReported: true,
  });
});

test("extractTokenBuckets reads nested Claude cache creation without double-counting", () => {
  const b = extractTokenBuckets({
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 0,
    cache_creation: {
      ephemeral_5m_input_tokens: 4,
      ephemeral_1h_input_tokens: 6,
      input_tokens: 10,
    },
  });
  assert.equal(b?.cacheWriteTokens, 10);
  assert.equal(b?.cacheReadTokens, 50);
});

test("extractTokenBuckets reads Codex cached_input_tokens fields", () => {
  const b = extractTokenBuckets({
    input_tokens: 1000,
    cached_input_tokens: 800,
    cache_write_input_tokens: 120,
    output_tokens: 25,
  });
  assert.deepEqual(b, {
    inputTokens: 1000,
    outputTokens: 25,
    cacheReadTokens: 800,
    cacheWriteTokens: 120,
    inputIncludesCache: true,
    cacheReported: true,
  });
});

// --- resolveSpanMs -------------------------------------------------------

test("resolveSpanMs accepts epoch seconds, epoch ms, ISO and Date, in either order", () => {
  const iso = "2026-08-03T16:43:14.076Z";
  const s = 1785775394; // epoch seconds
  const ms = 1785775394076;
  assert.deepEqual(resolveSpanMs(iso, iso), [Date.parse(iso), Date.parse(iso)]);
  assert.deepEqual(resolveSpanMs(s, ms), [1785775394000, ms]);
  assert.deepEqual(resolveSpanMs(new Date(iso), ms), [Date.parse(iso), ms]);
  // order-insensitive: last, first must normalise to start <= end
  assert.deepEqual(resolveSpanMs(1785866257, 1785775394), [1785775394000, 1785866257000]);
});

test("resolveSpanMs rejects non-spans instead of inventing one", () => {
  assert.equal(resolveSpanMs(null, "2026-08-03T00:00:00.000Z"), null);
  assert.equal(resolveSpanMs(0, 1785775394), null); // 0 is not a real timestamp
  assert.equal(resolveSpanMs("not a date", 1785775394), null);
  assert.equal(resolveSpanMs(123, 456), null); // tiny numbers are noise, not epochs
});

// --- splitRequestsOverSpan ----------------------------------------------

test("splitRequestsOverSpan preserves the total exactly", () => {
  const parts = splitRequestsOverSpan(3135, Date.parse("2026-08-03T16:00:00.000Z"), Date.parse("2026-08-04T17:00:00.000Z"));
  const sum = parts.reduce((n, p) => n + p.requestCount, 0);
  assert.equal(sum, 3135);
});

test("splitRequestsOverSpan spreads a session so the per-minute rate is not the session total", () => {
  // Real regression: a 3135-call session spanning ~25h was emitted on ONE
  // timestamp, so peak RPM read 3135. Spread over the real span the busiest
  // minute is a small fraction of the session total.
  const start = Date.parse("2026-08-03T16:43:14.000Z");
  const end = Date.parse("2026-08-04T17:57:37.000Z");
  const parts = splitRequestsOverSpan(3135, start, end);
  const peak = Math.max(...parts.map((p) => p.requestCount));
  assert.ok(peak < 100, `peak per minute should be far below the 3135 session total, got ${peak}`);
  assert.ok(parts.length > 1000, `expected one bucket per covered minute, got ${parts.length}`);
  // Every bucket sits inside the real span, so day attribution is correct too.
  for (const p of parts) {
    const t = Date.parse(p.timestamp);
    assert.ok(t >= Math.floor(start / 60000) * 60000 && t <= end, `bucket ${p.timestamp} escaped the span`);
  }
});

test("splitRequestsOverSpan gives a single minute for a zero-length span", () => {
  const t = Date.parse("2026-08-03T16:43:00.000Z");
  const parts = splitRequestsOverSpan(7, t, t);
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.requestCount, 7);
  assert.equal(parts[0]!.timestamp, new Date(t).toISOString());
});

test("splitRequestsOverSpan never emits a zero-request minute", () => {
  // More minutes than requests: the remainder is front-loaded, so trailing
  // minutes must be omitted rather than emitted with 0 requests.
  const start = Date.parse("2026-08-03T00:00:00.000Z");
  const end = Date.parse("2026-08-03T02:00:00.000Z"); // 121 minutes
  const parts = splitRequestsOverSpan(3, start, end);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map((p) => p.requestCount), [1, 1, 1]);
  assert.equal(parts.reduce((n, p) => n + p.requestCount, 0), 3);
});

test("splitRequestsOverSpan clamps a non-positive request count to one", () => {
  const t = Date.parse("2026-08-03T00:00:00.000Z");
  const parts = splitRequestsOverSpan(0, t, t);
  assert.equal(parts.reduce((n, p) => n + p.requestCount, 0), 1);
});
