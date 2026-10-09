import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LITELLM_GATED_MODELS,
  LITELLM_RPM_LIMIT,
  LITELLM_RPS_LIMIT,
  RequestRateGuard,
  litellmDefaultSpec,
  parseRateModels,
  parseRateWindows,
  replayThroughGuard,
} from "../src/rate-guard.js";

/**
 * These tests pin the behaviour reconstructed from
 * `glm_rps_limit.cpython-314.pyc`. Each assertion maps to a specific property
 * of the decompiled bytecode, so a future refactor that silently drifts from
 * LiteLLM's algorithm fails here.
 */

test("litellm default spec matches the recovered constants", () => {
  const spec = litellmDefaultSpec();
  assert.deepEqual(spec.models, LITELLM_GATED_MODELS);
  const byWindow = new Map(spec.windows.map((w) => [w.windowSeconds, w.limit]));
  assert.equal(byWindow.get(1), LITELLM_RPS_LIMIT, "1s window -> 1 req (RPS_LIMIT)");
  assert.equal(byWindow.get(60), LITELLM_RPM_LIMIT, "60s window -> 60 req (RPM_LIMIT)");
});

test("guard only gates its configured models", () => {
  const guard = new RequestRateGuard(litellmDefaultSpec());
  assert.equal(guard.appliesTo("GLM-5.3"), true, "case-insensitive");
  assert.equal(guard.appliesTo("  GLM-5.53  "), true, "whitespace trimmed");
  assert.equal(guard.appliesTo("claude-opus-5.5"), false);
  assert.equal(guard.appliesTo(null), false);});

test("empty model list gates everything", () => {
  const guard = new RequestRateGuard({ models: [], windows: [{ windowSeconds: 1, limit: 2 }] });
  assert.equal(guard.appliesTo("anything"), true);
  assert.equal(guard.appliesTo(null), true);
});

test("the limit is exclusive: RPS_LIMIT=1 rejects the second request in the same second", () => {
  // Upstream checks `len(second_starts) >= RPS_LIMIT`. With RPS_LIMIT = 1 an
  // already-recorded request inside 1s therefore blocks the next one.
  const guard = new RequestRateGuard({
    models: ["m"],
    windows: [{ windowSeconds: 1, limit: 1 }],
  });
  assert.equal(guard.admit("m", 100.0).allowed, true, "first request admitted");
  const second = guard.admit("m", 100.2);
  assert.equal(second.allowed, false, "second request inside 1s rejected");
  assert.deepEqual(second.rejectedBy, { windowSeconds: 1, limit: 1 });
  assert.equal(second.counts[0]!.count, 1, "count reflects the recorded request");
});

test("exactly one second later the request is allowed again", () => {
  const guard = new RequestRateGuard({
    models: ["m"],
    windows: [{ windowSeconds: 1, limit: 1 }],
  });
  guard.admit("m", 100.0);
  // Upstream window test is `now - t < window`, so a gap of exactly 1.0 is out.
  assert.equal(guard.admit("m", 101.0).allowed, true);
});

test("sliding window differs from calendar-minute bucketing", () => {
  // This is the reason TokenLab needs its own guard instead of reusing
  // computeActiveUsageRpm's floor(ts/60s) buckets: six calls straddling a
  // minute boundary are 6 in the rolling window but 2 under bucketing.
  const guard = new RequestRateGuard({
    models: ["m"],
    windows: [{ windowSeconds: 60, limit: 5 }],
  });
  // t=59.0 becomes the "previous minute"; t=60.0 starts a new bucket.
  const times = [59.0, 59.5, 59.7, 59.9, 60.0, 60.2];
  const admitted = times.filter((t) => guard.admit("m", t).allowed).length;
  assert.equal(admitted, 5, "rolling 60s window caps at the limit");
  // The blocked ones are the tail inside the same rolling minute, which a
  // calendar-bucket implementation would have counted as a fresh minute.
  const verdict = guard.check("m", 60.3);
  assert.equal(verdict.counts[0]!.count, 5);
});

test("RPM check uses len(_starts) and can reject after the per-second check passes", () => {
  const guard = new RequestRateGuard({
    models: ["m"],
    windows: [
      { windowSeconds: 1, limit: 10 },
      { windowSeconds: 60, limit: 3 },
    ],
  });
  assert.equal(guard.admit("m", 0.0).allowed, true);
  assert.equal(guard.admit("m", 20.0).allowed, true);
  const third = guard.admit("m", 40.0);
  assert.equal(third.allowed, true, "3rd request: count would be 3, check is >= 3 only before push");
  // Now _starts holds 3 entries; the 4th trips RPM because 3 >= 3.
  const fourth = guard.admit("m", 50.0);
  assert.equal(fourth.allowed, false);
  assert.deepEqual(fourth.rejectedBy, { windowSeconds: 60, limit: 3 });
});

test("Retry-After is max(1, ceil(window - (now - oldest_in_window)))", () => {
  const guard = new RequestRateGuard({
    models: ["m"],
    windows: [{ windowSeconds: 60, limit: 1 }],
  });
  guard.admit("m", 10.0);
  // At t=10.4 the entry is 0.4s old, so 60 - 0.4 = 59.6 -> ceil 60.
  const v = guard.check("m", 10.4);
  assert.equal(v.allowed, false);
  assert.equal(v.retryAfterSeconds, 60);
  // At t=69.3 it is 59.3s old -> 0.7 remaining -> ceil 1.
  const w = guard.check("m", 69.3);
  assert.equal(w.allowed, false, "still inside the 60s window");
  assert.equal(w.retryAfterSeconds, 1);
  // At t=70.0 the entry has aged out entirely.
  assert.equal(guard.check("m", 70.0).allowed, true);
});

test("Retry-After never returns 0 or a fraction", () => {
  const guard = new RequestRateGuard({
    models: ["m"],
    windows: [{ windowSeconds: 1, limit: 1 }],
  });
  guard.admit("m", 0.0);
  // At t=0.999 the remaining time is 0.001s -> ceil = 1, never 0.
  const v = guard.check("m", 0.999);
  assert.equal(v.retryAfterSeconds, 1);
  assert.ok(Number.isInteger(v.retryAfterSeconds));
});

test("a rejected request is not recorded, so a retry sees fresh state", () => {
  const guard = new RequestRateGuard({
    models: ["m"],
    windows: [{ windowSeconds: 60, limit: 1 }],
  });
  guard.admit("m", 0.0);
  for (let i = 0; i < 50; i++) guard.admit("m", 1.0 + i * 0.001);
  assert.equal(guard.size(2.0), 1, "only the admitted request is in state");
  // The window ages out from the ORIGINAL request, not from the retries.
  assert.equal(guard.check("m", 60.0).allowed, true);
});

test("stale entries are pruned by the widest window", () => {
  const guard = new RequestRateGuard({
    models: ["m"],
    windows: [
      { windowSeconds: 1, limit: 100 },
      { windowSeconds: 60, limit: 100 },
    ],
  });
  guard.admit("m", 0.0);
  guard.admit("m", 30.0);
  assert.equal(guard.size(30.0), 2);
  // At t=61 the first entry is 61s old and must be evicted by the 60s pass.
  assert.equal(guard.size(61.0), 1);
  assert.equal(guard.size(91.0), 0);
});

test("reset clears state", () => {
  const guard = new RequestRateGuard({
    models: ["m"],
    windows: [{ windowSeconds: 60, limit: 5 }],
  });
  guard.admit("m", 0.0);
  assert.equal(guard.size(0.5), 1);
  guard.reset();
  assert.equal(guard.size(0.5), 0);
});

test("a non-gated model is admitted and never recorded", () => {
  const guard = new RequestRateGuard(litellmDefaultSpec());
  const v = guard.admit("claude-opus-5.5", 0.0);
  assert.equal(v.allowed, true);
  assert.deepEqual(v.counts, [], "no windows reported for an un-gated model");
  assert.equal(guard.size(0.0), 0, "un-gated requests do not consume the budget");
});

test("message is shaped like the upstream ProxyRateLimitError detail", () => {
  const guard = new RequestRateGuard({
    models: ["glm-5.3"],
    windows: [{ windowSeconds: 1, limit: 1 }],
  });
  guard.admit("GLM-5.3", 5.0);
  const v = guard.check("GLM-5.3", 5.1);
  assert.equal(v.message, "glm-5.3 rate limit exceeded: maximum 1 requests per second");
});

test("replay reports exactly where upstream would have raised", () => {
  // Three requests inside one second against a 1/s limit: the 1st passes, the
  // 2nd and 3rd are rejected.
  const result = replayThroughGuard(
    { models: ["glm-5.3"], windows: [{ windowSeconds: 1, limit: 1 }] },
    "glm-5.3",
    [0.0, 0.1, 0.2],
  );
  assert.equal(result.admitted, 1);
  assert.equal(result.rejected, 2);
  assert.deepEqual(
    result.decisions.map((d) => d.allowed),
    [true, false, false],
  );
  assert.equal(result.decisions[1]!.retryAfterSeconds, 1);
});

test("replay over a spread-out stream admits everything", () => {
  const result = replayThroughGuard(
    litellmDefaultSpec(),
    "glm-5.3",
    [0.0, 1.0, 2.0, 3.0, 4.0],
  );
  assert.equal(result.rejected, 0, "1 req/s is satisfied by exactly 1s spacing");
  assert.equal(result.admitted, 5);
});

test("parseRateWindows accepts the documented syntax", () => {
  assert.deepEqual(parseRateWindows("5/30s,2/1s"), [
    { windowSeconds: 30, limit: 5 },
    { windowSeconds: 1, limit: 2 },
  ]);
  assert.deepEqual(parseRateWindows("1/1s,60/60s"), [
    { windowSeconds: 1, limit: 1 },
    { windowSeconds: 60, limit: 60 },
  ]);
  assert.deepEqual(parseRateWindows("10/5m"), [{ windowSeconds: 300, limit: 10 }]);
  assert.deepEqual(parseRateWindows(" 5 / 30 s "), [{ windowSeconds: 30, limit: 5 }]);
  assert.equal(parseRateWindows(""), null);
  assert.equal(parseRateWindows(null), null);
  assert.equal(parseRateWindows("garbage"), null, "unparseable config must not silently pass");
  assert.equal(parseRateWindows("0/1s"), null, "zero limit rejected");
});

test("parseRateModels handles all, lists, and blanks", () => {
  assert.deepEqual(parseRateModels("glm-5.3,GLM-5.53"), ["glm-5.3", "glm-5.53"]);
  assert.deepEqual(parseRateModels("*"), [], "'*' means every model");
  assert.equal(parseRateModels(""), null);
  assert.equal(parseRateModels(null), null);
  assert.equal(parseRateModels(" , , "), null, "only separators is not a list");
});

test("parseRateModels rejects entries that cannot be a model id", () => {
  // A guard whose model set matches nothing reports "limits enforced" while
  // blocking nothing, so unparseable input must be refused rather than kept.
  assert.equal(parseRateModels("!!!bad!!!"), null);
  assert.equal(parseRateModels("glm-5.3,@@@"), null, "one bad entry invalidates the list");
  // Real-world ids keep passing: dots, dashes, slashes, digits.
  assert.deepEqual(parseRateModels("anthropic/claude-opus-5.5"), ["anthropic/claude-opus-5.5"]);
  assert.deepEqual(parseRateModels("nvidia/nemotron-3-ultra-550b-a55b:free"), [
    "nvidia/nemotron-3-ultra-550b-a55b:free",
  ]);
});

test("a configured 5-per-30s guard enforces the provider-style limit", () => {
  // Mirrors the figures quoted in the provider warning, which differ from the
  // LiteLLM callback's own 1/s + 60/min. Both must be expressible.
  const guard = new RequestRateGuard({
    models: [],
    windows: [
      { windowSeconds: 1, limit: 2 },
      { windowSeconds: 30, limit: 5 },
    ],
  });
  // 2 requests in one second is the cap, so the 3rd inside 1s is refused.
  assert.equal(guard.admit("m", 0.0).allowed, true);
  assert.equal(guard.admit("m", 0.5).allowed, true);
  const third = guard.admit("m", 0.6);
  assert.equal(third.allowed, false);
  assert.deepEqual(third.rejectedBy, { windowSeconds: 1, limit: 2 });
});
