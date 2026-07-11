import path from "node:path";
import { appDataDir, expandHome, homeDir } from "./util.js";
import type { AgentId } from "./types.js";

export interface AgentPathSpec {
  id: AgentId;
  label: string;
  roots: string[];
}

export function agentPathSpecs(): AgentPathSpec[] {
  const home = homeDir();
  const appData = appDataDir();
  const localApp =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || path.join(home, "AppData", "Local")
      : home;
  const xdgData = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config");

  return [
    {
      id: "claude-code",
      label: "Claude Code",
      roots: unique([
        expandHome(process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude")),
        ...(process.env.CLAUDE_CONFIG_DIRS
          ? process.env.CLAUDE_CONFIG_DIRS.split(path.delimiter).map(expandHome)
          : []),
        path.join(home, ".config", "claude"),
      ]),
    },
    {
      id: "codex",
      label: "OpenAI Codex",
      roots: unique([
        expandHome(process.env.CODEX_HOME || path.join(home, ".codex")),
        path.join(home, ".codex"),
        path.join(xdgConfig, "codex"),
        path.join(appData, "Codex"),
        path.join(localApp, "Codex"),
      ]),
    },
    {
      id: "cursor",
      label: "Cursor",
      roots: unique([
        path.join(appData, "Cursor"),
        path.join(home, ".cursor"),
        path.join(localApp, "Cursor"),
        path.join(xdgConfig, "Cursor"),
      ]),
    },
    {
      id: "windsurf",
      label: "Windsurf",
      roots: unique([
        path.join(appData, "Windsurf"),
        path.join(home, ".codeium", "windsurf"),
        path.join(home, ".windsurf"),
        path.join(localApp, "Windsurf"),
      ]),
    },
    {
      id: "grok",
      label: "Grok (xAI)",
      roots: unique([path.join(home, ".grok"), path.join(appData, "Grok")]),
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      roots: unique([
        expandHome(process.env.GEMINI_CLI_HOME || path.join(home, ".gemini")),
        path.join(home, ".gemini"),
      ]),
    },
    {
      id: "opencode",
      label: "OpenCode",
      roots: unique([
        path.join(xdgData, "opencode"),
        path.join(home, ".local", "share", "opencode"),
        path.join(home, ".opencode"),
        path.join(appData, "opencode"),
      ]),
    },
    {
      id: "copilot",
      label: "GitHub Copilot",
      roots: unique([
        expandHome(process.env.COPILOT_OTEL_FILE_EXPORTER_PATH || path.join(home, ".copilot")),
        path.join(home, ".copilot"),
        path.join(appData, "GitHub Copilot"),
        path.join(appData, "Code", "User", "globalStorage", "github.copilot-chat"),
      ]),
    },
    {
      id: "hermes",
      label: "Hermes Agent",
      roots: unique([
        expandHome(process.env.HERMES_HOME || path.join(home, ".hermes")),
        path.join(home, ".hermes"),
        path.join(appData, "hermes"),
        path.join(localApp, "hermes"),
        path.join(xdgData, "hermes"),
        path.join(xdgConfig, "hermes"),
      ]),
    },
    {
      id: "openclaw",
      label: "OpenClaw",
      roots: unique([
        path.join(home, ".openclaw"),
        path.join(home, ".clawdbot"),
        path.join(home, ".moltbot"),
        path.join(home, ".moldbot"),
        path.join(appData, "openclaw"),
        path.join(localApp, "openclaw"),
        path.join(xdgData, "openclaw"),
        path.join(xdgConfig, "openclaw"),
      ]),
    },
    {
      id: "pi",
      label: "Pi / Oh My Pi",
      roots: unique([
        path.join(home, ".pi"),
        path.join(home, ".omp"),
        path.join(xdgData, "pi"),
      ]),
    },
    {
      id: "kimi",
      label: "Kimi CLI",
      roots: unique([
        expandHome(process.env.KIMI_SHARE_DIR || path.join(home, ".kimi")),
        path.join(home, ".kimi"),
        path.join(home, ".kimi-code"),
      ]),
    },
    {
      id: "qwen",
      label: "Qwen CLI",
      roots: unique([
        expandHome(process.env.QWEN_DATA_DIR || path.join(home, ".qwen")),
        path.join(home, ".qwen"),
      ]),
    },
    {
      id: "droid",
      label: "Factory Droid",
      roots: unique([
        expandHome(process.env.FACTORY_DIR || path.join(home, ".factory")),
        path.join(home, ".factory"),
      ]),
    },
    {
      id: "amp",
      label: "Amp",
      roots: unique([path.join(home, ".amp"), path.join(home, ".cache", "amp"), path.join(xdgData, "amp")]),
    },
    {
      id: "goose",
      label: "Goose",
      roots: unique([
        path.join(xdgData, "goose"),
        path.join(home, ".local", "share", "goose"),
        path.join(home, ".config", "goose"),
      ]),
    },
    {
      id: "cline",
      label: "Cline",
      roots: unique([
        path.join(home, ".cline"),
        path.join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev"),
        path.join(appData, "Cursor", "User", "globalStorage", "saoudrizwan.claude-dev"),
      ]),
    },
    {
      id: "roocode",
      label: "Roo Code",
      roots: unique([
        path.join(appData, "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline"),
        path.join(appData, "Cursor", "User", "globalStorage", "rooveterinaryinc.roo-cline"),
      ]),
    },
    {
      id: "kilocode",
      label: "Kilo Code",
      roots: unique([
        path.join(xdgData, "kilo"),
        path.join(home, ".local", "share", "kilo"),
        path.join(appData, "Code", "User", "globalStorage", "kilocode.kilo-code"),
      ]),
    },
    {
      id: "antigravity",
      label: "Antigravity",
      roots: unique([
        path.join(home, ".gemini"),
        path.join(appData, "Antigravity"),
        path.join(localApp, "Antigravity"),
      ]),
    },
    {
      id: "warp",
      label: "Warp AI",
      roots: unique([
        path.join(appData, "dev.warp.Warp-Stable"),
        path.join(home, "AppData", "Local", "warp"),
        path.join(home, "Library", "Group Containers", "2BBY89MBSN.dev.warp"),
      ]),
    },
    {
      id: "trae",
      label: "Trae",
      roots: unique([path.join(appData, "Trae"), path.join(home, ".trae")]),
    },
    {
      id: "zed",
      label: "Zed Agent",
      roots: unique([
        path.join(appData, "Zed"),
        path.join(xdgData, "zed"),
        path.join(home, "Library", "Application Support", "Zed"),
      ]),
    },
  ];
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}
