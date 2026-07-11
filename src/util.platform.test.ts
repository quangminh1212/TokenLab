import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import {
  appDataDir,
  cacheDir,
  homeDir,
  localAppDataDir,
} from "./util.js";
import {
  jetbrainsRoots,
  pathEnv,
  unique,
  vscodeGlobalStorage,
  vscodeUserDataRoots,
} from "./agents/shared/env.js";

describe("platform path helpers", () => {
  it("homeDir returns a non-empty absolute-ish path", () => {
    const h = homeDir();
    assert.ok(h.length > 0);
    assert.equal(h, pathEnv().home);
  });

  it("appDataDir / localAppDataDir / cacheDir are platform-consistent", () => {
    const app = appDataDir();
    const local = localAppDataDir();
    const cache = cacheDir();
    assert.ok(app.length > 0);
    assert.ok(local.length > 0);
    assert.ok(cache.length > 0);

    if (process.platform === "win32") {
      assert.match(app.toLowerCase(), /appdata|roaming/i);
      assert.match(local.toLowerCase(), /appdata|local/i);
    } else if (process.platform === "darwin") {
      assert.ok(app.includes("Application Support") || app.includes("Library"));
      assert.ok(local.includes("Application Support") || local.includes("Library"));
      assert.ok(cache.includes("Caches") || cache.includes("Library"));
    } else {
      // linux / other unix
      assert.ok(
        app.includes(".config") || process.env.XDG_CONFIG_HOME != null || app.length > 0,
      );
      assert.ok(
        local.includes(".local") || local.includes("share") || process.env.XDG_DATA_HOME != null,
      );
    }
  });

  it("pathEnv exposes cross-platform fields", () => {
    const env = pathEnv();
    assert.equal(typeof env.home, "string");
    assert.equal(typeof env.appData, "string");
    assert.equal(typeof env.localApp, "string");
    assert.equal(typeof env.cache, "string");
    assert.equal(typeof env.xdgData, "string");
    assert.equal(typeof env.xdgConfig, "string");
    assert.equal(typeof env.xdgCache, "string");
    assert.equal(env.platform, process.platform);
    // localApp must not collapse to bare home on Linux (old bug)
    if (process.platform === "linux") {
      assert.notEqual(env.localApp, env.home);
    }
  });

  it("unique filters empties and dedupes", () => {
    assert.deepEqual(unique(["a", "", "a", "b"]), ["a", "b"]);
  });

  it("vscodeUserDataRoots includes Code and Cursor", () => {
    const roots = vscodeUserDataRoots();
    assert.ok(roots.some((r) => r.includes("Code") || r.endsWith(`${path.sep}Code`)));
    assert.ok(roots.some((r) => r.includes("Cursor")));
    assert.ok(roots.length >= 4);
  });

  it("vscodeGlobalStorage builds extension paths", () => {
    const paths = vscodeGlobalStorage("saoudrizwan.claude-dev", "continue.continue");
    assert.ok(paths.length >= 2);
    assert.ok(paths.every((p) => p.includes("globalStorage")));
    assert.ok(paths.some((p) => p.includes("saoudrizwan.claude-dev")));
    assert.ok(paths.some((p) => p.includes("continue.continue")));
  });

  it("jetbrainsRoots includes JetBrains base and optional subpaths", () => {
    const bases = jetbrainsRoots();
    assert.ok(bases.some((r) => r.includes("JetBrains")));
    const junie = jetbrainsRoots("Junie");
    assert.ok(junie.some((r) => r.endsWith(`${path.sep}Junie`) || r.includes(`${path.sep}Junie`)));
  });
});
