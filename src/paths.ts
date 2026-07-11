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

  return [
    {
      id: "claude-code",
      label: "Claude Code",
      roots: [
        expandHome(process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude")),
        path.join(home, ".config", "claude"),
      ],
    },
    {
      id: "codex",
      label: "OpenAI Codex",
      roots: [
        expandHome(process.env.CODEX_HOME || path.join(home, ".codex")),
      ],
    },
    {
      id: "cursor",
      label: "Cursor",
      roots: [
        path.join(appData, "Cursor"),
        path.join(home, ".cursor"),
        path.join(localApp, "Cursor"),
      ],
    },
    {
      id: "windsurf",
      label: "Windsurf",
      roots: [
        path.join(appData, "Windsurf"),
        path.join(home, ".codeium", "windsurf"),
        path.join(home, ".windsurf"),
        path.join(localApp, "Windsurf"),
      ],
    },
    {
      id: "grok",
      label: "Grok (xAI)",
      roots: [
        path.join(home, ".grok"),
        path.join(appData, "Grok"),
      ],
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      roots: [
        expandHome(process.env.GEMINI_CLI_HOME || path.join(home, ".gemini")),
      ],
    },
    {
      id: "opencode",
      label: "OpenCode",
      roots: [
        path.join(home, ".local", "share", "opencode"),
        path.join(home, ".opencode"),
        process.env.XDG_DATA_HOME
          ? path.join(process.env.XDG_DATA_HOME, "opencode")
          : path.join(home, ".local", "share", "opencode"),
      ],
    },
    {
      id: "copilot",
      label: "GitHub Copilot",
      roots: [
        path.join(home, ".copilot"),
        path.join(appData, "GitHub Copilot"),
      ],
    },
  ];
}
