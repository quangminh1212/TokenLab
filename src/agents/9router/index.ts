import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { appDataDir, homeDir } from "../../util.js";
import { parseRouterUsage } from "../shared/router-usage.js";
import path from "node:path";

/**
 * 9Router proxy manager usage.
 * Local roots (Windows / macOS / Linux) + optional VPS mirror under xlab-token data dir.
 *
 * VPS layout (my.bnix.one): /root/.9router/{usage.json, db/data.sqlite, db.json}
 */
export function nineRouterRoots(): string[] {
  const { home, appData, localApp, xdgData, xdgConfig, path: p, expandHome } = pathEnv();
  const xlabData =
    process.env.XLAB_TOKEN_DATA_DIR ||
    p.join(appDataDir(), "xlab-token");
  return unique([
    expandHome(process.env.NINEROUTER_HOME || process.env.NINE_ROUTER_HOME || ""),
    expandHome(process.env.XLAB_TOKEN_9ROUTER_DIR || ""),
    p.join(home, ".9router"),
    p.join(appData, "9router"),
    p.join(localApp, "9router"),
    p.join(xdgConfig, "9router"),
    p.join(xdgData, "9router"),
    // Local mirror of VPS data (synced manually or via scripts)
    p.join(xlabData, "mirrors", "9router"),
    p.join(homeDir(), ".xlab-token", "mirrors", "9router"),
    // Dev machine convenience (C:\Dev\VPS\... on Windows)
    process.platform === "win32" ? "C:\\Dev\\VPS\\my.bnix.one\\9router\\data" : "",
    p.join(home, "Dev", "VPS", "my.bnix.one", "9router", "data"),
  ]);
}

export const agent: AgentModule = {
  id: "9router",
  label: "9Router",
  roots: nineRouterRoots,
  parse: (roots) => parseRouterUsage(roots, "9router"),
};
