# XLab Token

**Local-first token API usage & cost tracker for every AI agent on one machine.**

XLab Token is an npm package that runs a lightweight **localhost** service and dashboard. It aggregates **token API consumption** and **estimated spend (cost)** from all AI coding agents and CLIs installed on the host — including **Cursor**, **Grok**, **Windsurf**, **Codex**, **Claude Code**, and more — so you always know **how many tokens each agent used and how much it cost**.

No cloud account required by default. Data stays on your machine.

---

## Table of contents

- [What it tracks](#what-it-tracks)
- [Why](#why)
- [Features](#features)
- [How it works](#how-it-works)
- [Supported agents](#supported-agents)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [CLI reference](#cli-reference)
- [HTTP API](#http-api)
- [Cost engine](#cost-engine)
- [Configuration](#configuration)
- [Data model](#data-model)
- [Privacy & security](#privacy--security)
- [Development](#development)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## What it tracks

| Dimension | Details |
|-----------|---------|
| **Token API usage** | Input, output, cache-read, cache-write tokens per request / session |
| **Spend (cost)** | Estimated USD (or configured currency) from model pricing × tokens |
| **By agent** | Cursor, Grok, Windsurf, Codex, Claude Code, … |
| **By model** | e.g. `claude-sonnet-4`, `gpt-4.1`, `grok-3`, … |
| **By time** | Hour / day / week / custom range |
| **By workspace** | Project path when available in agent logs |

**Primary questions answered**

1. How many tokens did **all agents on this PC** use today / this month?
2. Which agent burned the most tokens and **money**?
3. Which models drive the highest cost?
4. What is the running **total spend** across every local agent?

---

## Why

Modern machines often run **multiple AI agents in parallel**. Each tool stores usage in a different path and format. Without one local aggregator:

| Pain point | Impact |
|------------|--------|
| Fragmented token logs | No machine-wide token total |
| Opaque spend | Cannot see real API cost across agents |
| No cross-agent ranking | Hard to know which tool is expensive |
| Cloud-only dashboards | Privacy / offline limits |

XLab Token scans **local agent usage artifacts**, normalizes them into one schema, computes **token totals + cost**, and serves them on **localhost HTTP + UI**.

---

## Features

- **Token API tracking** — input / output / cache tokens from every supported agent
- **Cost / spend tracking** — estimated currency cost per event, agent, model, and period
- **All agents on one machine** — single dashboard for Cursor, Grok, Windsurf, Codex, Claude Code, …
- **Localhost-only service** — binds to `127.0.0.1` by default
- **Live refresh** — filesystem watchers + periodic rescan
- **Breakdowns & rankings** — top agents, top models, spend over time
- **Stable JSON API** — automate budgets, status bars, scripts
- **npm-first UX** — `npx` / `bunx` / global binary
- **Offline-friendly pricing** — bundled price table; optional refresh

---

## How it works

```
┌──────────────────────────────────────────────────────────────────┐
│                         Host machine                             │
│                                                                  │
│  Cursor · Grok · Windsurf · Codex · Claude Code · Copilot · …    │
│       │        │         │        │           │                  │
│       └────────┴────┬────┴────────┴───────────┘                  │
│                     ▼                                            │
│           ┌─────────────────────┐                                │
│           │ Scanners / parsers  │  → UsageEvent (tokens)         │
│           └──────────┬──────────┘                                │
│                      ▼                                           │
│           ┌─────────────────────┐                                │
│           │ Cost engine         │  tokens × model price          │
│           └──────────┬──────────┘                                │
│                      ▼                                           │
│           ┌─────────────────────┐                                │
│           │ SQLite local store  │  events + rollups              │
│           └──────────┬──────────┘                                │
│           ┌──────────┴──────────┐                                │
│           ▼                     ▼                                │
│    HTTP API :3737         Dashboard (localhost)                  │
│    /api/stats · /api/cost                                        │
└──────────────────────────────────────────────────────────────────┘
```

1. **Discover** agent data directories on Windows / macOS / Linux.
2. **Parse** local usage / session files into unified `UsageEvent` records (tokens).
3. **Price** each event with the cost engine (model rate × token buckets).
4. **Aggregate** tokens + spend by agent, model, time, workspace.
5. **Serve** via `http://127.0.0.1:<port>` for UI and automation.

### Agent modules

Each agent lives in its own folder under `src/agents/<id>/` (one module = paths + parser):

```text
src/agents/
  shared/          # generic-jsonl, usage-fields, path helpers
  claude-code/     # index.ts → export const agent
  codex/
  grok/
  …
  index.ts         # registry: AGENTS, scanAll, detectAgents
```

To add a new agent: create `src/agents/<id>/index.ts` exporting `agent: AgentModule`, then register it in `src/agents/index.ts`.

---

## Supported agents

**Goal:** track **token API usage and spend for every major agent on the machine**.

| Agent / client | Canonical id | Typical sources | Parser |
|----------------|--------------|-----------------|--------|
| **OpenAI Codex CLI** | `codex` | `~/.codex/sessions` rollout JSONL (deep) | Yes |
| **Hermes Agent** | `hermes` | `~/.hermes/state.db` + JSONL | Yes |
| **OpenClaw** (+ clawdbot/moltbot) | `openclaw` | `~/.openclaw/agents/**/sessions` | Yes |
| **Cursor** | `cursor` | App data usage JSON/JSONL | Yes |
| **Grok** (xAI) | `grok` | `~/.grok/sessions` | Yes |
| **Windsurf** | `windsurf` | Codeium / Windsurf app data | Yes |
| **Claude Code** | `claude-code` | `~/.claude/projects` JSONL | Yes |
| Gemini CLI | `gemini` | `~/.gemini/tmp/**/chats` | Yes |
| OpenCode | `opencode` | local share / storage | Yes |
| GitHub Copilot | `copilot` | `~/.copilot/otel` JSONL | Yes |
| Pi / Oh My Pi | `pi` | `~/.pi` / `~/.omp` sessions | Yes |
| Kimi CLI | `kimi` | `~/.kimi/**/wire.jsonl` | Yes |
| Qwen CLI | `qwen` | `~/.qwen/projects` | Yes |
| Factory Droid | `droid` | `~/.factory` | Yes |
| Amp | `amp` | `~/.amp` | Yes |
| Goose | `goose` | XDG goose data | Yes |
| Cline | `cline` | VS Code globalStorage | Yes |
| Roo Code | `roocode` | VS Code globalStorage | Yes |
| Kilo Code | `kilocode` | kilo data / globalStorage | Yes |
| Antigravity | `antigravity` | gemini / antigravity data | Yes |
| Warp AI | `warp` | Warp app data | Yes |
| Trae | `trae` | Trae app data | Yes |
| Zed Agent | `zed` | Zed threads data | Yes |
| Codebuff | `codebuff` | `~/.config/manicode` | Yes |
| Mux | `mux` | `~/.mux/sessions` | Yes |
| Crush | `crush` | XDG crush data | Yes |
| Kiro | `kiro` | `~/.kiro` + IDE globalStorage | Yes |
| Gajae-Code | `gjc` | `~/.gjc/agent/sessions` | Yes |
| Jcode | `jcode` | `~/.jcode/sessions` | Yes |
| Command Code | `commandcode` | `~/.commandcode/projects` | Yes |
| JetBrains Junie | `junie` | `~/.junie/sessions` | Yes |
| ZCode | `zcode` | `~/.zcode/projects` | Yes |
| OpenCodeReview | `opencodereview` | `~/.opencodereview/sessions` | Yes |
| CodeBuddy | `codebuddy` | `~/.codebuddy/projects` | Yes |
| WorkBuddy | `workbuddy` | `~/.workbuddy/projects` | Yes |
| Aider | `aider` | `~/.aider` analytics / history | Yes |
| Continue.dev | `continue` | `~/.continue` + VS Code storage | Yes |
| Devin | `devin` | `%APPDATA%/devin/cli/sessions.db` | Yes |
| Ollama | `ollama` | `~/.ollama` | Yes |
| CodeWhale | `codewhale` | `~/.codewhale` / `~/.deepseek` | Yes |
| MiMo Code | `mimocode` | `$MIMOCODE_HOME` / `~/.mimocode` | Yes |
| Qoder | `qoder` | `~/.qoder` | Yes |
| iFlow | `iflow` | `~/.iflow` | Yes |
| Blackbox AI | `blackbox` | VS Code globalStorage / `~/.blackbox` | Yes |
| Forge | `forge` | `~/.forge` | Yes |
| Void | `void` | Void app data | Yes |
| Amazon Q | `amazon-q` | `~/.aws/amazonq` / VS Code storage | Yes |

> XLab Token only **reads local files** already on disk. It does not inject into agent processes or call vendor billing APIs unless you explicitly enable an optional integration later.

Parsers ship incrementally; `xlab-token doctors` reports which agents are detected and which parsers are active.

---

## Requirements

| Item | Minimum |
|------|---------|
| Runtime | Node.js **20+** or Bun **1.1+** |
| OS | Windows 10+, macOS 12+, Linux |
| Network | None required (localhost + offline pricing) |
| Disk | ~50 MB install + local DB growth |

---

## Quick start

Works on **Windows**, **macOS**, and **Linux** (Node.js 20+).

### One-shot

```bash
npx xlab-token@latest serve
# or
bunx xlab-token@latest serve
```

### Global install

```bash
npm install -g xlab-token
xlab-token serve
# optional: open default browser
xlab-token serve --open
```

Open:

```text
http://127.0.0.1:3737
```

### Local clone (dev / hot reload)

```bash
git clone https://github.com/quangminh1212/XLab_Token.git
cd XLab_Token
npm install

# Windows
run.bat

# macOS / Linux
chmod +x run.sh
./run.sh

# or cross-platform
npm run serve:watch
```

### Token + cost snapshot (CLI)

```bash
# All agents: tokens and estimated spend
xlab-token stats --json

# Last 24 hours, ranked by cost
xlab-token stats --since 24h --by agent --sort cost

# Cost only summary
xlab-token cost --since 7d --currency USD

# Which agents exist on this machine
xlab-token doctors
```

---

## CLI reference

| Command | Description |
|---------|-------------|
| `xlab-token serve` | Start localhost API + dashboard (tokens + cost) |
| `xlab-token scan` | Rescan all agent sources |
| `xlab-token stats` | Aggregate **tokens + spend** to stdout |
| `xlab-token cost` | Focused **spend** report (totals, by agent/model) |
| `xlab-token export` | Export events (tokens + cost fields) as JSON/CSV |
| `xlab-token doctors` | Detect agents, paths, parser health |
| `xlab-token --version` | Package version |

### Common flags

| Flag | Default | Description |
|------|---------|-------------|
| `--host` | `127.0.0.1` | Bind address |
| `--port` | `3737` | HTTP port |
| `--data-dir` | OS app data | SQLite + config directory |
| `--since` / `--until` | — | Time range for stats/cost |
| `--by` | `agent` | `agent` \| `model` \| `day` \| `hour` |
| `--sort` | `tokens` | `tokens` \| `cost` |
| `--currency` | `USD` | Display currency for cost |
| `--no-ui` | off | API only |
| `--watch` | on | FS watchers while serving |
| `--json` | off | Machine-readable output |

---

## HTTP API

Base URL: `http://127.0.0.1:3737`  
`Content-Type: application/json; charset=utf-8`

### `GET /api/health`

```json
{
  "ok": true,
  "version": "0.1.0",
  "uptimeSec": 120,
  "agentsDetected": ["cursor", "claude-code", "codex", "windsurf", "grok"]
}
```

### `GET /api/stats` — tokens **and** cost

| Param | Type | Description |
|-------|------|-------------|
| `since` | string | ISO-8601 or relative (`24h`, `7d`, `30d`) |
| `until` | string | End bound |
| `groupBy` | string | `agent` \| `model` \| `day` \| `hour` |
| `agent` | string | Filter one agent id |
| `currency` | string | Cost currency (default `USD`) |

```json
{
  "totals": {
    "inputTokens": 1200000,
    "outputTokens": 340000,
    "cacheReadTokens": 80000,
    "cacheWriteTokens": 12000,
    "totalTokens": 1632000,
    "estimatedCost": 18.42,
    "currency": "USD"
  },
  "groups": [
    {
      "key": "cursor",
      "inputTokens": 400000,
      "outputTokens": 90000,
      "totalTokens": 490000,
      "estimatedCost": 6.20
    },
    {
      "key": "claude-code",
      "inputTokens": 500000,
      "outputTokens": 120000,
      "totalTokens": 620000,
      "estimatedCost": 7.10
    },
    {
      "key": "windsurf",
      "inputTokens": 150000,
      "outputTokens": 40000,
      "totalTokens": 190000,
      "estimatedCost": 2.40
    },
    {
      "key": "codex",
      "inputTokens": 100000,
      "outputTokens": 50000,
      "totalTokens": 150000,
      "estimatedCost": 1.80
    },
    {
      "key": "grok",
      "inputTokens": 50000,
      "outputTokens": 40000,
      "totalTokens": 90000,
      "estimatedCost": 0.92
    }
  ]
}
```

### `GET /api/cost` — spend-focused

| Param | Type | Description |
|-------|------|-------------|
| `since` / `until` | string | Time range |
| `groupBy` | string | `agent` \| `model` \| `day` |
| `currency` | string | e.g. `USD` |

```json
{
  "currency": "USD",
  "totalEstimatedCost": 18.42,
  "period": { "since": "2026-07-01T00:00:00.000Z", "until": "2026-07-11T23:59:59.999Z" },
  "byAgent": [
    { "agent": "claude-code", "estimatedCost": 7.10, "share": 0.385 },
    { "agent": "cursor", "estimatedCost": 6.20, "share": 0.337 }
  ],
  "byModel": [
    { "model": "claude-sonnet-4", "estimatedCost": 5.50 },
    { "model": "gpt-4.1", "estimatedCost": 3.10 }
  ]
}
```

### `GET /api/events`

Paginated usage events (tokens + cost per row).

| Param | Type | Description |
|-------|------|-------------|
| `limit` | number | Default `100`, max `1000` |
| `cursor` | string | Pagination cursor |
| `agent` | string | e.g. `cursor`, `windsurf`, `grok` |

### `GET /api/agents`

List detected agents and parser status.

```json
{
  "agents": [
    { "id": "cursor", "detected": true, "enabled": true, "lastEventAt": "2026-07-11T10:00:00.000Z" },
    { "id": "grok", "detected": true, "enabled": true, "lastEventAt": "2026-07-11T09:30:00.000Z" },
    { "id": "windsurf", "detected": true, "enabled": true, "lastEventAt": "2026-07-11T08:00:00.000Z" },
    { "id": "codex", "detected": true, "enabled": true, "lastEventAt": "2026-07-10T22:00:00.000Z" },
    { "id": "claude-code", "detected": true, "enabled": true, "lastEventAt": "2026-07-11T11:00:00.000Z" }
  ]
}
```

### `POST /api/scan`

```json
{ "ok": true, "eventsIngested": 42, "durationMs": 318 }
```

### Errors

```json
{
  "error": {
    "code": "INVALID_QUERY",
    "message": "groupBy must be one of: agent, model, day, hour"
  }
}
```

Status: `400` validation · `404` not found · `500` internal.

---

## Cost engine

Spend is computed **locally** from token buckets and a pricing table:

```text
cost = (inputTokens      × priceInputPer1M
      + outputTokens     × priceOutputPer1M
      + cacheReadTokens  × priceCacheReadPer1M
      + cacheWriteTokens × priceCacheWritePer1M) / 1_000_000
```

| Topic | Behavior |
|-------|----------|
| Price source | Bundled offline snapshot of common model rates |
| Unknown model | Marked `pricing: "unknown"`; cost may be `null` or use fallback tier |
| Currency | Default `USD`; display conversion optional |
| Accuracy | **Estimate** — may differ from provider invoices |
| Override | User can set custom rates in config |

---

## Configuration

```text
# Windows
%APPDATA%\xlab-token\config.json

# macOS
~/Library/Application Support/xlab-token/config.json

# Linux
~/.config/xlab-token/config.json
```

```json
{
  "host": "127.0.0.1",
  "port": 3737,
  "watch": true,
  "pricing": {
    "source": "bundled",
    "currency": "USD",
    "customRates": {
      "my-local-model": {
        "inputPer1M": 0,
        "outputPer1M": 0
      }
    }
  },
  "agents": {
    "cursor": { "enabled": true },
    "grok": { "enabled": true },
    "windsurf": { "enabled": true },
    "codex": { "enabled": true },
    "claude-code": { "enabled": true },
    "copilot": { "enabled": true },
    "opencode": { "enabled": true }
  },
  "paths": {
    "overrides": {}
  }
}
```

| Environment variable | Meaning |
|----------------------|---------|
| `XLAB_TOKEN_HOST` | Bind host |
| `XLAB_TOKEN_PORT` | Bind port |
| `XLAB_TOKEN_DATA_DIR` | Data directory |
| `XLAB_TOKEN_CURRENCY` | Cost currency |
| `XLAB_TOKEN_NO_UI` | `1` = API only |

---

## Data model

### `UsageEvent`

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Stable hash (source + native id) |
| `agent` | string | `cursor` \| `grok` \| `windsurf` \| `codex` \| `claude-code` \| … |
| `model` | string \| null | Provider model id |
| `timestamp` | string | ISO-8601 UTC |
| `inputTokens` | number | API input / prompt tokens |
| `outputTokens` | number | API output / completion tokens |
| `cacheReadTokens` | number | Cache read tokens (if any) |
| `cacheWriteTokens` | number | Cache write tokens (if any) |
| `totalTokens` | number | Sum of token buckets |
| `estimatedCost` | number \| null | Computed spend in `currency` |
| `currency` | string | e.g. `USD` |
| `pricingStatus` | string | `priced` \| `unknown_model` \| `zero_rate` |
| `workspace` | string \| null | Project path when known |
| `sourcePath` | string | Local file parsed |
| `raw` | object \| null | Sanitized native fields (no full prompts by default) |

### Storage

- **SQLite** under data directory
- Append-only events + rollup tables (tokens + cost by agent/model/day)
- Idempotent ingest on `id`

---

## Privacy & security

| Principle | Practice |
|-----------|----------|
| Local by default | `127.0.0.1` only |
| No account | No signup required |
| Prefer counters | Tokens + cost, not full chat bodies |
| User-owned DB | All data under `data-dir` |
| Explicit network | Optional price-table update only if enabled |

Do not bind to `0.0.0.0` on untrusted networks. Treat the DB as sensitive if workspace paths are stored.

---

## Development

```bash
git clone https://github.com/quangminh1212/XLab_Token.git
cd XLab_Token
npm install
npm test
npm run build
npm start
```

| OS | Dev launcher |
|----|----------------|
| Windows | `run.bat` |
| macOS / Linux | `./run.sh` |
| Any | `npm run serve:watch` |

Agent data paths are resolved per platform (`%APPDATA%` / `~/Library/Application Support` / XDG). Extension-based agents also scan VS Code, Cursor, VSCodium, Code - OSS, and Windsurf `globalStorage`.

```text
src/
  agents/   # one folder per agent (paths + parser)
  server/   # HTTP API + dashboard
  cli.ts    # xlab-token binary
```

| Script | Purpose |
|--------|---------|
| `dev` | CLI via tsx |
| `serve:watch` | API + UI hot reload |
| `build` | Production build |
| `test` | Unit + parser fixtures |
| `typecheck` | TypeScript check |

---

## Implementation status (v0.1.0)

Integrated feature set inspired by **tokscale**, **codeburn**, and **ccusage** (see [`ATTRIBUTION.md`](./ATTRIBUTION.md)):

| Area | Status |
|------|--------|
| Multi-agent local scanners | **Done** — 23 agents incl. Codex (deep), Hermes, OpenClaw |
| Token + cost aggregation | **Done** — `stats` / `cost` / `/api/stats` / `/api/cost` |
| Bundled offline pricing | **Done** — LiteLLM-style rates in `src/pricing.ts` |
| Localhost dashboard | **Done** — `xlab-token serve` → `http://127.0.0.1:3737` |
| Agent detection (`doctors`) | **Done** |
| Hermes SQLite (`state.db`) | **Done** — via `node:sqlite` + JSONL fallback |
| OpenClaw / clawdbot / moltbot | **Done** — sessions index + JSONL usage |
| Codex deep scan | **Done** — sessions/history/archived, cumulative token_count |
| Grok session estimate | **Done** — real usage if present, else text-length estimate |
| Cursor SQLite (`state.vscdb`) | Planned (JSON/JSONL caches supported now) |
| SQLite persistent store | Planned (in-memory scan each run for v0.1) |
| LiteLLM live price refresh | Planned |

### Dev commands

```bash
npm install
npm run build
npm test
npx tsx src/cli.ts doctors
npx tsx src/cli.ts stats --since 7d
npx tsx src/cli.ts cost --since 7d
npx tsx src/cli.ts serve --port 3737
```

## Roadmap

- [x] Core scanner + cost engine (TypeScript)
- [x] P0 parsers: Cursor, Grok, Windsurf, Codex, Claude Code (+ Gemini, OpenCode)
- [x] Bundled model price table
- [x] Dashboard + HTTP API
- [x] CLI: `stats`, `cost`, `scan`, `doctors`, `serve`
- [ ] Deeper Cursor SQLite + Copilot parsers
- [ ] Persistent SQLite store / incremental scan
- [ ] Optional LiteLLM price refresh
- [ ] Plugin API for custom agents

---

## Contributing

1. Fork and branch from `main`.
2. Add parser fixtures for each agent (token fields required; cost via engine).
3. Prefer small PRs; Conventional Commits (`feat:`, `fix:`, `docs:`).

---

## License

MIT License — see [`LICENSE`](./LICENSE) when published.

---

## Disclaimer

XLab Token reads **local usage artifacts** from third-party agents. Formats may change without notice. **Token counts and costs are best-effort estimates** and may differ from official provider billing dashboards or invoices.
