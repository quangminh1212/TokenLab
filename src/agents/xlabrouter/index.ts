import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { appDataDir, homeDir } from "../../util.js";
import { parseRouterUsage } from "../shared/router-usage.js";

/**
 * XLab Router (xlabrouter / xlab_router) usage.
 *
 * VPS systemd unit uses:
 *   Environment=DATA_DIR=/var/lib/xlabrouter
 *   PORT=1212
 * Not ~/.xlabrouter (legacy empty install path).
 */
export function xlabRouterRoots(): string[] {
  const { home, appData, localApp, xdgData, xdgConfig, path: p, expandHome } = pathEnv();
  const xlabData =
    process.env.TOKENLAB_DATA_DIR ||
    p.join(appDataDir(), "tokenlab");
  return unique([
    // Explicit overrides (preferred)
    expandHome(process.env.TOKENLAB_XLABROUTER_DIR || ""),
    expandHome(process.env.XLABROUTER_HOME || process.env.XLAB_ROUTER_HOME || ""),
    expandHome(process.env.XLABROUTER_DATA_DIR || ""),
    // Service DATA_DIR (VPS production)
    expandHome(process.env.DATA_DIR || ""),
    "/var/lib/xlabrouter",
    p.join("/var", "lib", "xlabrouter"),
    // Legacy / desktop installs
    p.join(home, ".xlabrouter"),
    p.join(appData, "xlabrouter"),
    p.join(localApp, "xlabrouter"),
    p.join(xdgConfig, "xlabrouter"),
    p.join(xdgData, "xlabrouter"),
    p.join(appData, "xlab_router"),
    p.join(home, ".xlab_router"),
    // Local mirrors of VPS DATA_DIR
    p.join(xlabData, "mirrors", "xlabrouter"),
    p.join(homeDir(), ".tokenlab", "mirrors", "xlabrouter"),
    // Pre-rename legacy mirror paths — usage never drops across the rename.
    p.join(appDataDir(), "xlab-token", "mirrors", "xlabrouter"),
    p.join(homeDir(), ".xlab-token", "mirrors", "xlabrouter"),
    process.platform === "win32" ? "C:\\Dev\\VPS\\my.bnix.one\\xlabrouter\\data" : "",
    p.join(home, "Dev", "VPS", "my.bnix.one", "xlabrouter", "data"),
  ]);
}

export const agent: AgentModule = {
  id: "xlabrouter",
  label: "XLab Router",
  roots: xlabRouterRoots,
  parse: (roots) => parseRouterUsage(roots, "xlabrouter"),
};
