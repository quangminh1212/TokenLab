import path from "node:path";
import {
  appDataDir,
  cacheDir,
  expandHome,
  homeDir,
  localAppDataDir,
} from "../../util.js";

/** VS Code–family product folder names used for User/globalStorage discovery. */
const VSCODE_PRODUCT_NAMES = [
  "Code",
  "Code - Insiders",
  "Code - OSS",
  "VSCodium",
  "Cursor",
  "Cursor - Nightly",
  "Windsurf",
  "Windsurf - Insiders",
  "Trae",
  "Void",
  "Antigravity",
] as const;

export function pathEnv() {
  const home = homeDir();
  const appData = appDataDir();
  const localApp = localAppDataDir();
  const cache = cacheDir();
  const xdgData = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const xdgCache = process.env.XDG_CACHE_HOME || path.join(home, ".cache");
  const platform = process.platform;
  return {
    home,
    appData,
    localApp,
    cache,
    xdgData,
    xdgConfig,
    xdgCache,
    platform,
    path,
    expandHome,
  };
}

export function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

/**
 * Candidate user-data roots for VS Code family editors on this OS.
 * Covers Windows (%APPDATA%/%LOCALAPPDATA%), macOS (Application Support),
 * and Linux (XDG config + data).
 */
export function vscodeUserDataRoots(extraProducts: string[] = []): string[] {
  const { home, appData, localApp, xdgConfig, xdgData, path: p } = pathEnv();
  const names = [...VSCODE_PRODUCT_NAMES, ...extraProducts];
  const roots: string[] = [];

  for (const name of names) {
    roots.push(p.join(appData, name));
    roots.push(p.join(localApp, name));
    // Linux: also probe XDG paths explicitly (appData already = xdgConfig, but
    // some distros / portable installs use data home).
    if (process.platform === "linux") {
      roots.push(p.join(xdgConfig, name));
      roots.push(p.join(xdgData, name));
    }
    // Portable / legacy home folders
    roots.push(p.join(home, `.${name.toLowerCase().replace(/\s+/g, "-")}`));
  }

  return unique(roots);
}

/**
 * `User/globalStorage/<extensionId>` paths across all known VS Code forks.
 * Use for IDE extensions (Cline, Roo, Copilot chat, Continue, …).
 */
export function vscodeGlobalStorage(...extensionIds: string[]): string[] {
  const { path: p } = pathEnv();
  const out: string[] = [];
  for (const root of vscodeUserDataRoots()) {
    for (const id of extensionIds) {
      if (!id) continue;
      out.push(p.join(root, "User", "globalStorage", id));
    }
  }
  return unique(out);
}

/**
 * JetBrains config/data roots (Windows / macOS / Linux).
 * https://www.jetbrains.com/help/idea/directories-used-by-the-ide-to-store-settings-caches-plugins-and-logs.html
 */
export function jetbrainsRoots(...subpaths: string[]): string[] {
  const { home, appData, localApp, xdgConfig, xdgData, path: p } = pathEnv();
  const bases = unique([
    p.join(appData, "JetBrains"),
    p.join(localApp, "JetBrains"),
    p.join(xdgConfig, "JetBrains"),
    p.join(xdgData, "JetBrains"),
    // macOS Toolbox / legacy
    p.join(home, "Library", "Application Support", "JetBrains"),
    p.join(home, "Library", "Caches", "JetBrains"),
  ]);
  if (subpaths.length === 0) return bases;
  const out: string[] = [];
  for (const base of bases) {
    for (const sub of subpaths) {
      out.push(p.join(base, sub));
    }
  }
  return unique(out);
}
