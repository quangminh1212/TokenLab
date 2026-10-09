import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LITELLM_GATED_MODELS,
  LITELLM_RPM_LIMIT,
  LITELLM_RPS_LIMIT,
  litellmDefaultSpec,
  resolveRateSpec,
} from "../src/rate-guard.js";
import { defaultFlagThresholds, resolveFlagThresholds } from "../src/flag-report.js";

test("resolveRateSpec falls back to the recovered upstream constants", () => {
  const r = resolveRateSpec({ env: {} });
  assert.equal(r.windowsSource, "upstream-default");
  assert.equal(r.modelsSource, "upstream-default");
  assert.equal(r.isUpstreamDefault, true);
  assert.deepEqual(r.spec.models, LITELLM_GATED_MODELS);
  const byWindow = new Map(r.spec.windows.map((w) => [w.windowSeconds, w.limit]));
  assert.equal(byWindow.get(1), LITELLM_RPS_LIMIT);
  assert.equal(byWindow.get(60), LITELLM_RPM_LIMIT);
});

test("env overrides config for windows and models", () => {
  const r = resolveRateSpec({
    configWindows: "1/1s,60/60s",
    configModels: "glm-5.3",
    env: {
      TOKENLAB_RATE_LIMIT_WINDOWS: "5/30s,2/1s",
      TOKENLAB_RATE_LIMIT_MODELS: "*",
    },
  });
  assert.equal(r.windowsSource, "env");
  assert.equal(r.modelsSource, "env");
  assert.equal(r.isUpstreamDefault, false);
  assert.deepEqual(r.spec.windows, [
    { windowSeconds: 30, limit: 5 },
    { windowSeconds: 1, limit: 2 },
  ]);
  assert.deepEqual(r.spec.models, [], "'*' means every model");
  assert.deepEqual(r.warnings, []);
});

test("config is used when no env override is present", () => {
  const r = resolveRateSpec({
    configWindows: "10/60s",
    configModels: "glm-5.53",
    env: {},
  });
  assert.equal(r.windowsSource, "config");
  assert.equal(r.modelsSource, "config");
  assert.deepEqual(r.spec.windows, [{ windowSeconds: 60, limit: 10 }]);
  assert.deepEqual(r.spec.models, ["glm-5.53"]);
});

test("a malformed env override warns and falls back rather than being ignored", () => {
  const r = resolveRateSpec({
    configWindows: "10/60s",
    env: { TOKENLAB_RATE_LIMIT_WINDOWS: "not-a-limit" },
  });
  assert.equal(r.windowsSource, "config", "falls through to the config value");
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /TOKENLAB_RATE_LIMIT_WINDOWS/);
  assert.deepEqual(r.spec.windows, [{ windowSeconds: 60, limit: 10 }]);
});

test("a malformed override with no config falls back to upstream defaults", () => {
  const r = resolveRateSpec({ env: { TOKENLAB_RATE_LIMIT_MODELS: "!!!bad!!!" } });
  assert.equal(r.modelsSource, "upstream-default");
  assert.equal(r.warnings.length, 1);
  assert.deepEqual(r.spec.models, LITELLM_GATED_MODELS);
});

test("blank override strings are treated as absent, not as errors", () => {
  const r = resolveRateSpec({
    configWindows: "  ",
    env: { TOKENLAB_RATE_LIMIT_WINDOWS: "", TOKENLAB_RATE_LIMIT_MODELS: "   " },
  });
  assert.equal(r.isUpstreamDefault, true);
  assert.deepEqual(r.warnings, []);
});

test("resolveFlagThresholds returns the documented defaults", () => {
  const t = resolveFlagThresholds(null);
  assert.deepEqual(t, defaultFlagThresholds());
  assert.equal(t.spanHours, 18);
  assert.equal(t.automatedGapShare, 0.9);
});

test("resolveFlagThresholds applies valid overrides", () => {
  const t = resolveFlagThresholds({
    spanHours: 12,
    activeHours: 8,
    continuousGapSeconds: 120,
    maxIdleHours: 2,
    automatedGapShare: 0.75,
  });
  assert.equal(t.spanHours, 12);
  assert.equal(t.activeHours, 8);
  assert.equal(t.continuousGapSeconds, 120);
  assert.equal(t.maxIdleHours, 2);
  assert.equal(t.automatedGapShare, 0.75);
});

test("resolveFlagThresholds rejects out-of-range values per field", () => {
  const base = defaultFlagThresholds();
  // Negative hours and shares outside 0..1 are meaningless; each bad field must
  // fall back on its own without discarding the caller's good fields.
  const t = resolveFlagThresholds({
    spanHours: -5,
    activeHours: 999,
    continuousGapSeconds: 0,
    automatedGapShare: 1.5,
  });
  assert.equal(t.spanHours, base.spanHours, "negative hours rejected");
  assert.equal(t.activeHours, base.activeHours, "absurd hours rejected");
  assert.equal(t.continuousGapSeconds, base.continuousGapSeconds, "zero gap rejected");
  assert.equal(t.automatedGapShare, base.automatedGapShare, "share > 1 rejected");
});

test("maxIdleHours accepts 0, which is a meaningful threshold", () => {
  // 0 must survive: it is the default and it means "no idle hour allowed".
  const t = resolveFlagThresholds({ maxIdleHours: 0 });
  assert.equal(t.maxIdleHours, 0);
});

test("a full spec round-trips through the guard", () => {
  // Proves the resolver output is directly consumable, which is the whole point
  // of resolving rather than threading raw strings through the server.
  const resolved = resolveRateSpec({ env: { TOKENLAB_RATE_LIMIT_WINDOWS: "3/10s" } });
  assert.deepEqual(resolved.spec.windows, [{ windowSeconds: 10, limit: 3 }]);
});
