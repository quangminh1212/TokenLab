import type { AgentModule } from "../shared/types.js";
import { pathEnv, unique } from "../shared/env.js";
import { appDataDir, homeDir } from "../../util.js";
import { parseRouterUsage } from "../shared/router-usage.js";

/**
 * LiteLLM proxy usage (VPS :4000).
 *
 * Remote SoT: Postgres `LiteLLM_SpendLogs` + `LiteLLM_DailyUserSpend`
 *   (service WorkingDirectory=/opt/litellm, DATABASE_URL → litellm DB)
 *
 * Local mirrors (synced by scripts/sync-vps-mirrors.py like 9router):
 *   %APPDATA%/tokenlab/mirrors/litellm/{usage-daily.json,usage-history.jsonl,db.json}
 *
 * Same router-usage envelope as 9router so daily rollups + RECENT EVENTS work.
 */
export function liteLlmRoots(): string[] {
  const { home, appData, localApp, xdgData, xdgConfig, path: p, expandHome } = pathEnv();
  const xlabData =
    process.env.TOKENLAB_DATA_DIR ||
    p.join(appDataDir(), "tokenlab");
  return unique([
    expandHome(process.env.TOKENLAB_LITELLM_DIR || process.env.LITELLM_HOME || ""),
    expandHome(process.env.LITELLM_DATA_DIR || ""),
    // VPS mirrors first (Windows TokenLab — source of truth for remote :4000)
    p.join(xlabData, "mirrors", "litellm"),
    p.join(homeDir(), ".tokenlab", "mirrors", "litellm"),
    p.join(appDataDir(), "xlab-token", "mirrors", "litellm"),
    p.join(homeDir(), ".xlab-token", "mirrors", "litellm"),
    process.platform === "win32" ? "C:\\Dev\\VPS\\my.bnix.one\\litellm\\data" : "",
    p.join(home, "Dev", "VPS", "my.bnix.one", "litellm", "data"),
    // If TokenLab ever runs on the VPS host itself
    "/opt/litellm/data",
    p.join(home, ".litellm"),
    p.join(appData, "litellm"),
    p.join(localApp, "litellm"),
    p.join(xdgConfig, "litellm"),
    p.join(xdgData, "litellm"),
  ]);
}

export const agent: AgentModule = {
  id: "litellm",
  label: "LiteLLM",
  roots: liteLlmRoots,
  parse: (roots) => parseRouterUsage(roots, "litellm"),
};
