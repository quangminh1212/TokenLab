import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { restoreBackup, mirrorsRoot } from "./backup.js";
import { pathExists } from "./util.js";

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
