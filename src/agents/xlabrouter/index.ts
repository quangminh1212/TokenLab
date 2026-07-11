import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { appDataDir, homeDir } from "../../util.js";
import { parseRouterUsage } from "../shared/router-usage.js";

/**
 * XLab Router (xlabrouter / xlab_router) usage.
 * Same data shape as 9router; typically %APPDATA%/xlabrouter or ~/.xlabrouter.
 *
 * VPS layout: /root/.xlabrouter/{db.json, logs}
 */
export function xlabRouterRoots(): string[] {
  const { home, appData, localApp, xdgData, xdgConfig, path: p, expandHome } = pathEnv();
  const xlabData =
    process.env.XLAB_TOKEN_DATA_DIR ||
    p.join(appDataDir(), "xlab-token");
  return unique([
    expandHome(process.env.XLABROUTER_HOME || process.env.XLAB_ROUTER_HOME || ""),
    expandHome(process.env.XLAB_TOKEN_XLABROUTER_DIR || ""),
    p.join(home, ".xlabrouter"),
    p.join(appData, "xlabrouter"),
    p.join(localApp, "xlabrouter"),
    p.join(xdgConfig, "xlabrouter"),
    p.join(xdgData, "xlabrouter"),
    // npm package name variant
    p.join(appData, "xlab_router"),
    p.join(home, ".xlab_router"),
    // Local mirror of VPS data
    p.join(xlabData, "mirrors", "xlabrouter"),
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
