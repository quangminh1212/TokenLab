import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { appDataDir, homeDir } from "../../util.js";
import { parseRouterUsage } from "../shared/router-usage.js";

/**
 * RouterLab usage (rebrand of xlabrouter / XLab Router).
 *
 * Remote source of truth (same as http://HOST:1212/dashboard/usage):
 *   systemd Environment=DATA_DIR=/var/lib/xlabrouter  PORT=1212
 *
 * Local mirrors (synced by scripts/sync-vps-mirrors.py like 9router):
 *   %APPDATA%/tokenlab/mirrors/{xlabrouter,routerlab}
 */
export function xlabRouterRoots(): string[] {
  const { home, appData, localApp, xdgData, xdgConfig, path: p, expandHome } = pathEnv();
  const xlabData =
    process.env.TOKENLAB_DATA_DIR ||
    p.join(appDataDir(), "tokenlab");
  return unique([
    // Explicit overrides (preferred)
    expandHome(process.env.TOKENLAB_XLABROUTER_DIR || process.env.TOKENLAB_ROUTERLAB_DIR || ""),
    expandHome(process.env.XLABROUTER_HOME || process.env.XLAB_ROUTER_HOME || process.env.ROUTERLAB_HOME || ""),
    expandHome(process.env.XLABROUTER_DATA_DIR || process.env.ROUTERLAB_DATA_DIR || ""),
    // Local mirrors of VPS DATA_DIR FIRST (Windows TokenLab — source of truth for remote :1212)
    // Must beat empty/local AppData installs that would otherwise shadow VPS usage.
    p.join(xlabData, "mirrors", "routerlab"),
    p.join(xlabData, "mirrors", "xlabrouter"),
    p.join(homeDir(), ".tokenlab", "mirrors", "routerlab"),
    p.join(homeDir(), ".tokenlab", "mirrors", "xlabrouter"),
    p.join(appDataDir(), "xlab-token", "mirrors", "routerlab"),
    p.join(appDataDir(), "xlab-token", "mirrors", "xlabrouter"),
    p.join(homeDir(), ".xlab-token", "mirrors", "routerlab"),
    p.join(homeDir(), ".xlab-token", "mirrors", "xlabrouter"),
    process.platform === "win32" ? "C:\\Dev\\VPS\\my.bnix.one\\routerlab\\data" : "",
    process.platform === "win32" ? "C:\\Dev\\VPS\\my.bnix.one\\xlabrouter\\data" : "",
    p.join(home, "Dev", "VPS", "my.bnix.one", "routerlab", "data"),
    p.join(home, "Dev", "VPS", "my.bnix.one", "xlabrouter", "data"),
    // Service DATA_DIR (VPS production / when TokenLab runs on the same host)
    expandHome(process.env.DATA_DIR || ""),
    "/var/lib/xlabrouter",
    p.join("/var", "lib", "xlabrouter"),
    // Legacy / desktop installs (often empty on Windows — keep last)
    p.join(home, ".xlabrouter"),
    p.join(home, ".routerlab"),
    p.join(appData, "xlabrouter"),
    p.join(appData, "routerlab"),
    p.join(localApp, "xlabrouter"),
    p.join(localApp, "routerlab"),
    p.join(xdgConfig, "xlabrouter"),
    p.join(xdgConfig, "routerlab"),
    p.join(xdgData, "xlabrouter"),
    p.join(xdgData, "routerlab"),
    p.join(appData, "xlab_router"),
    p.join(home, ".xlab_router"),
  ]);
}

export const agent: AgentModule = {
  id: "routerlab",
  label: "RouterLab",
  roots: xlabRouterRoots,
  parse: (roots) => parseRouterUsage(roots, "routerlab"),
};
