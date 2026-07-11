import path from "node:path";
import { appDataDir, expandHome, homeDir } from "../../util.js";

export function pathEnv() {
  const home = homeDir();
  const appData = appDataDir();
  const localApp =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || path.join(home, "AppData", "Local")
      : home;
  const xdgData = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return { home, appData, localApp, xdgData, xdgConfig, path, expandHome };
}

export function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}
