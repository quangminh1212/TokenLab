import type { AgentId, AgentStatus, UsageEvent } from "../types.js";
import { pathExists } from "../util.js";
import { agent as claude_code } from "./claude-code/index.js";
import { agent as codex } from "./codex/index.js";
import { agent as cursor } from "./cursor/index.js";
import { agent as windsurf } from "./windsurf/index.js";
import { agent as grok } from "./grok/index.js";
import { agent as gemini } from "./gemini/index.js";
import { agent as opencode } from "./opencode/index.js";
import { agent as hermes } from "./hermes/index.js";
import { agent as openclaw } from "./openclaw/index.js";
import { agent as copilot } from "./copilot/index.js";
import { agent as pi } from "./pi/index.js";
import { agent as kimi } from "./kimi/index.js";
import { agent as qwen } from "./qwen/index.js";
import { agent as droid } from "./droid/index.js";
import { agent as amp } from "./amp/index.js";
import { agent as goose } from "./goose/index.js";
import { agent as cline } from "./cline/index.js";
import { agent as roocode } from "./roocode/index.js";
import { agent as kilocode } from "./kilocode/index.js";
import { agent as antigravity } from "./antigravity/index.js";
import { agent as warp } from "./warp/index.js";
import { agent as trae } from "./trae/index.js";
import { agent as zed } from "./zed/index.js";
import { agent as codebuff } from "./codebuff/index.js";
import { agent as mux } from "./mux/index.js";
import { agent as crush } from "./crush/index.js";
import { agent as kiro } from "./kiro/index.js";
import { agent as gjc } from "./gjc/index.js";
import { agent as jcode } from "./jcode/index.js";
import { agent as commandcode } from "./commandcode/index.js";
import { agent as junie } from "./junie/index.js";
import { agent as zcode } from "./zcode/index.js";
import { agent as opencodereview } from "./opencodereview/index.js";
import { agent as codebuddy } from "./codebuddy/index.js";
import { agent as workbuddy } from "./workbuddy/index.js";
import { agent as aider } from "./aider/index.js";
import { agent as agent_continue } from "./continue/index.js";
import { agent as amazon_q } from "./amazon-q/index.js";
import { agent as void_agent } from "./void/index.js";
import { agent as forge } from "./forge/index.js";
import { agent as blackbox } from "./blackbox/index.js";
import { agent as iflow } from "./iflow/index.js";
import { agent as qoder } from "./qoder/index.js";
import { agent as mimocode } from "./mimocode/index.js";
import { agent as codewhale } from "./codewhale/index.js";
import { agent as ollama } from "./ollama/index.js";
import { agent as devin } from "./devin/index.js";
import { agent as nine_router } from "./9router/index.js";
import { agent as xlab_router } from "./xlabrouter/index.js";
import type { AgentModule, AgentPathSpec } from "./shared/types.js";

export type { AgentModule, AgentPathSpec } from "./shared/types.js";

/** All agent modules (one folder each under src/agents/). */
export const AGENTS: AgentModule[] = [
  claude_code,
  codex,
  cursor,
  windsurf,
  grok,
  gemini,
  opencode,
  hermes,
  openclaw,
  copilot,
  pi,
  kimi,
  qwen,
  droid,
  amp,
  goose,
  cline,
  roocode,
  kilocode,
  antigravity,
  warp,
  trae,
  zed,
  codebuff,
  mux,
  crush,
  kiro,
  gjc,
  jcode,
  commandcode,
  junie,
  zcode,
  opencodereview,
  codebuddy,
  workbuddy,
  aider,
  agent_continue,
  devin,
  ollama,
  codewhale,
  mimocode,
  qoder,
  iflow,
  blackbox,
  forge,
  void_agent,
  amazon_q,
  nine_router,
  xlab_router,
];

export const PARSERS: Record<AgentId, AgentModule["parse"] | null> = {
  ...Object.fromEntries(AGENTS.map((a) => [a.id, a.parse])) as Record<AgentId, AgentModule["parse"]>,
  custom: null,
};

export function agentPathSpecs(): AgentPathSpec[] {
  return AGENTS.map((a) => ({
    id: a.id,
    label: a.label,
    roots: a.roots(),
  }));
}

export async function scanAll(enabled?: Partial<Record<AgentId, boolean>>): Promise<UsageEvent[]> {
  const all: UsageEvent[] = [];

  for (const mod of AGENTS) {
    if (enabled && enabled[mod.id] === false) continue;
    const roots: string[] = [];
    for (const r of mod.roots()) {
      if (await pathExists(r)) roots.push(r);
    }
    if (roots.length === 0) continue;
    try {
      // Avoid push(...hugeArray) — spread arg list overflows the stack at ~100k+ events
      const batch = await mod.parse(roots);
      for (const e of batch) all.push(e);
    } catch (err) {
      console.error("[xlab-token] parser " + mod.id + " failed:", err instanceof Error ? err.message : err);
    }
  }

  all.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return all;
}

export async function detectAgents(events: UsageEvent[] = []): Promise<AgentStatus[]> {
  const byAgent = new Map<string, UsageEvent[]>();
  for (const e of events) {
    const list = byAgent.get(e.agent) ?? [];
    list.push(e);
    byAgent.set(e.agent, list);
  }

  const out: AgentStatus[] = [];
  for (const mod of AGENTS) {
    const paths: string[] = [];
    for (const r of mod.roots()) {
      if (await pathExists(r)) paths.push(r);
    }
    const list = byAgent.get(mod.id) ?? [];
    const last = list.length ? (list.map((e) => e.timestamp).sort().at(-1) ?? null) : null;
    out.push({
      id: mod.id,
      label: mod.label,
      detected: paths.length > 0,
      enabled: true,
      paths,
      lastEventAt: last,
      eventCount: list.length,
    });
  }
  return out;
}
