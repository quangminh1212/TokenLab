import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  DEFAULT_FULL_SCAN_INTERVAL_MINUTES,
  DEFAULT_SCAN_INTERVAL_MINUTES,
  configPath,
  fullScanIntervalMinutes,
  loadConfig,
  resetConfigCache,
  saveConfig,
  scanIntervalMinutes,
  scanPeriodicEnabled,
} from "../src/config.js";

/**
 * `tests/*.test.ts` share ONE process, so the config module cache and the
 * TOKENLAB_* env vars are global. This suite must restore both on the way out,
 * otherwise a later suite (e.g. periodic-hermes-scan) loads config from a temp
 * dir this suite already deleted.
 */
const ENV_KEYS = ["TOKENLAB_CONFIG", "TOKENLAB_DATA_DIR"] as const;

let dir = "";
let savedEnv = new Map<string, string | undefined>();

before(async () => {
  savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  dir = await mkdtemp(path.join(tmpdir(), "tokenlab-scan-"));
  process.env.TOKENLAB_CONFIG = path.join(dir, "config.json");
  process.env.TOKENLAB_DATA_DIR = dir;
  resetConfigCache();
});

after(async () => {
  // Order matters: drop the temp config, restore env, then flush the cache so
  // the next suite re-reads whatever it expects instead of our deleted file.
  resetConfigCache();
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigCache();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("scan config", () => {
  it("defaults to a 5-minute light cadence and a 6-hour full cadence", async () => {
    const cfg = await loadConfig();
    assert.equal(cfg.scan?.intervalMinutes, DEFAULT_SCAN_INTERVAL_MINUTES);
    assert.equal(cfg.scan?.fullIntervalMinutes, DEFAULT_FULL_SCAN_INTERVAL_MINUTES);
    assert.equal(cfg.scan?.periodicEnabled, true);
    assert.equal(scanIntervalMinutes(), 5);
    assert.equal(fullScanIntervalMinutes(), 360);
    assert.equal(scanPeriodicEnabled(), true);
  });

  it("persists a saved cadence and applies it without a restart", async () => {
    const prev = await loadConfig();
    await saveConfig({ ...prev, scan: { intervalMinutes: 10, fullIntervalMinutes: 720 } });
    assert.equal(scanIntervalMinutes(), 10);
    assert.equal(fullScanIntervalMinutes(), 720);

    const onDisk = JSON.parse(await readFile(configPath(), "utf8"));
    assert.equal(onDisk.scan.intervalMinutes, 10);
    assert.equal(onDisk.scan.fullIntervalMinutes, 720);
  });

  it("keeps periodicEnabled true unless explicitly turned off", async () => {
    const prev = await loadConfig();
    // Merge drops the key when a partial PUT omits it — default must stay on.
    await saveConfig({ ...prev, scan: { intervalMinutes: 7 } });
    assert.equal(scanPeriodicEnabled(), true);
    assert.equal(scanIntervalMinutes(), 7);

    await saveConfig({ ...prev, scan: { periodicEnabled: false } });
    assert.equal(scanPeriodicEnabled(), false);
  });

  it("clamps out-of-range values so config.json cannot force a scan loop", async () => {
    const prev = await loadConfig();
    await saveConfig({
      ...prev,
      scan: { intervalMinutes: 0, fullIntervalMinutes: 99999 },
    });
    assert.equal(scanIntervalMinutes(), 1);
    assert.equal(fullScanIntervalMinutes(), 1440);

    await saveConfig({ ...prev, scan: { intervalMinutes: 999 } });
    assert.equal(scanIntervalMinutes(), 60);
  });

  it("falls back to defaults for non-numeric junk", async () => {
    const prev = await loadConfig();
    await saveConfig({
      ...prev,
      // Hand-edited config.json with strings instead of numbers
      scan: { intervalMinutes: "abc" as unknown as number },
    });
    assert.equal(scanIntervalMinutes(), DEFAULT_SCAN_INTERVAL_MINUTES);

    await writeFile(
      configPath(),
      JSON.stringify({ scan: { intervalMinutes: "abc", periodicEnabled: true } }),
      "utf8",
    );
    resetConfigCache();
    const cfg = await loadConfig();
    assert.equal(cfg.scan?.intervalMinutes, DEFAULT_SCAN_INTERVAL_MINUTES);
    assert.equal(scanIntervalMinutes(), DEFAULT_SCAN_INTERVAL_MINUTES);
  });

  it("never drops a sibling scan field on a partial update", async () => {
    resetConfigCache();
    await saveConfig({
      timezone: "local",
      scan: { intervalMinutes: 15, fullIntervalMinutes: 180, periodicEnabled: true },
    });
    const prev = await loadConfig();
    await saveConfig({ ...prev, scan: { ...prev.scan, intervalMinutes: 30 } });
    assert.equal(scanIntervalMinutes(), 30);
    assert.equal(fullScanIntervalMinutes(), 180);
  });
});
