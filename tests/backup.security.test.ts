import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  restoreBackup,
  mirrorsRoot,
  mergeEventsByIdPreferRicher,
  preferRicherEvent,
} from "../src/backup.js";
import type { UsageEvent } from "../src/types.js";
import { pathExists } from "../src/util.js";

function evt(partial: Partial<UsageEvent> & { id: string }): UsageEvent {
  return {
    agent: "devin",
    model: null,
    timestamp: "2026-07-15T00:00:00.000Z",
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 110,
    estimatedCost: 1,
    currency: "USD",
    pricingStatus: "priced",
    workspace: null,
    sourcePath: "/x",
    ...partial,
  };
}

test("preferRicherEvent fills null model even when default cost is higher", () => {
  const stale = evt({
    id: "same",
    model: null,
    estimatedCost: 5,
    totalTokens: 110,
  });
  const fresh = evt({
    id: "same",
    model: "glm-5-2",
    estimatedCost: 0.2,
    totalTokens: 110,
  });
  const kept = preferRicherEvent(stale, fresh);
  assert.equal(kept.model, "glm-5-2");
  assert.equal(kept.estimatedCost, 0.2);
});

test("mergeEventsByIdPreferRicher upgrades null-model cache rows", () => {
  const cached = [
    evt({ id: "a", model: null, estimatedCost: 9, inputTokens: 50, totalTokens: 60 }),
    evt({ id: "b", model: "swe-1-6", estimatedCost: 1, inputTokens: 50, totalTokens: 60 }),
  ];
  const scanned = [
    evt({ id: "a", model: "kimi-k2-7", estimatedCost: 0.5, inputTokens: 50, totalTokens: 60 }),
    evt({ id: "b", model: "swe-1-6", estimatedCost: 1, inputTokens: 50, totalTokens: 60 }),
  ];
  const merged = mergeEventsByIdPreferRicher(scanned, cached);
  const byId = Object.fromEntries(merged.map((e) => [e.id, e]));
  assert.equal(byId.a.model, "kimi-k2-7");
  assert.equal(byId.b.model, "swe-1-6");
});

test("restore mirrors blocks path traversal", async () => {
  const root = mirrorsRoot();
  const evilRel = path.join(root, "..", "..", "evil-xlab-traversal-test.txt");
  // clean any previous
  try {
    await rm(evilRel, { force: true });
  } catch {
    /* ignore */
  }

  const result = await restoreBackup({
    format: "xlab-token-backup",
    formatVersion: 2,
    appVersion: "1.0.1",
    exportedAt: new Date().toISOString(),
    scope: "full",
    config: {
      timezone: "Asia/Ho_Chi_Minh",
      pricing: { currency: "USD", preferRouterCost: true, customRates: {} },
    },
    mirrors: {
      "../../evil-xlab-traversal-test.txt": "pwned",
      "..\\..\\evil-xlab-traversal-test2.txt": "pwned",
      "safe-test/nested.json": '{"ok":true}',
    },
  });

  assert.equal(await pathExists(evilRel), false, "must not write outside mirrors root");
  assert.ok(result.mirrorsRestored >= 1, "safe file should restore");
  const safe = path.join(root, "safe-test", "nested.json");
  assert.equal(await pathExists(safe), true);
  const body = await readFile(safe, "utf8");
  assert.equal(body, '{"ok":true}');
  // cleanup safe test file
  try {
    await rm(path.join(root, "safe-test"), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test("restore accepts v1 settings-only backup", async () => {
  const r = await restoreBackup({
    format: "xlab-token-backup",
    formatVersion: 1,
    appVersion: "1.0.1",
    exportedAt: new Date().toISOString(),
    config: {
      timezone: "UTC",
      pricing: {
        currency: "USD",
        preferRouterCost: false,
        customRates: { "test-model-xlab": { inputPer1M: 1, outputPer1M: 2 } },
      },
    },
  });
  assert.equal(r.ok, true);
  assert.ok(r.customRateCount >= 1);
  assert.equal(r.events, undefined);
});
