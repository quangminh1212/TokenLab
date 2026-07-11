# XLab Token

**Local-first token usage tracker for every AI agent on a single machine.**

XLab Token is an npm package that runs a lightweight **localhost** service and dashboard. It aggregates token consumption from AI coding agents and CLI tools installed on the host (Claude Code, Cursor, Codex, Copilot, OpenCode, Grok, and others), so you can see **who used how many tokens, when, and at what estimated cost** — without sending raw session logs to a third-party cloud by default.

---

## Table of contents

- [Why](#why)
- [Features](#features)
- [How it works](#how-it-works)
- [Supported agents](#supported-agents)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [CLI reference](#cli-reference)
- [HTTP API](#http-api)
- [Configuration](#configuration)
- [Data model](#data-model)
- [Privacy & security](#privacy--security)
- [Development](#development)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Why

Modern development machines often run **multiple AI agents at once**. Each tool stores usage in a different path, format, and unit. Without a single local aggregator:

| Pain point | Impact |
|------------|--------|
| Fragmented logs | No machine-wide view of total tokens |
| Opaque cost | Hard to estimate spend across providers |
| No cross-agent timeline | Difficult to correlate spikes with work sessions |
| Cloud-only dashboards | Privacy and offline constraints |

XLab Token solves this by scanning **local agent data directories**, normalizing records into a common schema, and exposing them via **localhost HTTP + a simple web UI**.

---

## Features

- **Localhost-only service** — binds to `127.0.0.1` by default; no public bind required
- **Multi-agent aggregation** — one pipeline for all agents installed on the machine
- **Token & cost tracking** — input / output / cache tokens with pluggable pricing tables
- **Real-time refresh** — filesystem watchers + periodic rescan
- **Timeline & breakdowns** — by agent, model, day/hour, and project path (when available)
- **Zero cloud account** — works offline; optional export only
- **npm-first UX** — install once, run with `npx` / `bunx` / global binary
- **Stable JSON API** — integrate with scripts, status bars, and other local tools

---

## How it works

```
┌─────────────────────────────────────────────────────────────┐
│                     Host machine                            │
│                                                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  │ Claude   │ │ Cursor   │ │ Codex    │ │ Other    │        │
│  │ sessions │ │ logs     │ │ usage    │ │ agents   │        │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘        │
│       │            │            │            │              │
│       └────────────┴─────┬──────┴────────────┘              │
│                          ▼                                  │
│              ┌───────────────────────┐                      │
│              │  Scanner / parsers    │                      │
│              │  (normalize → events) │                      │
│              └───────────┬───────────┘                      │
│                          ▼                                  │
│              ┌───────────────────────┐                      │
│              │  Local store (SQLite) │                      │
│              └───────────┬───────────┘                      │
│                          ▼                                  │
│         ┌────────────────┴────────────────┐                 │
│         ▼                                 ▼                 │
│  ┌─────────────┐                   ┌─────────────┐          │
│  │ HTTP API    │                   │ Dashboard   │          │
│  │ :3737       │                   │ (localhost) │          │
│  └─────────────┘                   └─────────────┘          │
└─────────────────────────────────────────────────────────────┘
```

1. **Discover** known agent data paths on the OS (Windows / macOS / Linux).
2. **Parse** session or usage files into a unified `UsageEvent` schema.
3. **Aggregate** by time window, agent, model, and optional workspace.
4. **Serve** stats on `http://127.0.0.1:<port>` for UI and automation.

---

## Supported agents

Initial target set (parsers may ship incrementally):

| Agent / client     | Source type              | Status   |
|--------------------|--------------------------|----------|
| Claude Code        | Local session transcripts| Planned  |
| Cursor             | Local usage / DB         | Planned  |
| OpenAI Codex CLI   | Local session logs       | Planned  |
| GitHub Copilot     | Local telemetry caches   | Planned  |
| OpenCode           | Local store              | Planned  |
| Grok / xAI tools   | Local session logs       | Planned  |
| Custom / generic   | Drop folder + JSONL      | Planned  |

> **Note:** Support depends on each vendor’s local file layout. XLab Token only reads **local** files the user already has; it does not inject into agent processes.

---

## Requirements

| Item        | Minimum                          |
|-------------|----------------------------------|
| Runtime     | Node.js **20+** or Bun **1.1+**  |
| OS          | Windows 10+, macOS 12+, Linux    |
| Network     | None (localhost only)            |
| Disk        | ~50 MB install + usage DB growth |

---

## Quick start

### One-shot (recommended)

```bash
# npm
npx xlab-token@latest

# bun
bunx xlab-token@latest
```

### Global install

```bash
npm install -g xlab-token
xlab-token
```

### Typical first run

```bash
xlab-token serve --port 3737
```

Then open:

```text
http://127.0.0.1:3737
```

### Headless stats (no UI)

```bash
xlab-token stats --json
xlab-token stats --since 24h --by agent
```

---

## CLI reference

| Command | Description |
|---------|-------------|
| `xlab-token serve` | Start localhost API + dashboard |
| `xlab-token scan` | One-shot rescan of all agent sources |
| `xlab-token stats` | Print aggregated usage to stdout |
| `xlab-token export` | Export events as JSON / CSV |
| `xlab-token doctors` | Diagnose missing paths and parsers |
| `xlab-token --version` | Print package version |

### Common flags

| Flag | Default | Description |
|------|---------|-------------|
| `--host` | `127.0.0.1` | Bind address (localhost only recommended) |
| `--port` | `3737` | HTTP port |
| `--data-dir` | OS app data | Directory for SQLite DB and config |
| `--no-ui` | off | API only |
| `--watch` | on | Enable filesystem watchers while serving |
| `--json` | off | Machine-readable CLI output |

---

## HTTP API

Base URL: `http://127.0.0.1:3737`

All responses use `Content-Type: application/json; charset=utf-8` unless noted.

### `GET /api/health`

```json
{
  "ok": true,
  "version": "0.1.0",
  "uptimeSec": 120
}
```

### `GET /api/stats`

Query parameters:

| Param | Type | Description |
|-------|------|-------------|
| `since` | string | ISO-8601 timestamp or relative (`24h`, `7d`) |
| `until` | string | ISO-8601 end bound |
| `groupBy` | string | `agent` \| `model` \| `day` \| `hour` |

Example response:

```json
{
  "totals": {
    "inputTokens": 1200000,
    "outputTokens": 340000,
    "cacheReadTokens": 80000,
    "cacheWriteTokens": 12000,
    "estimatedCostUsd": 18.42
  },
  "groups": [
    {
      "key": "claude-code",
      "inputTokens": 500000,
      "outputTokens": 120000,
      "estimatedCostUsd": 7.10
    }
  ]
}
```

### `GET /api/events`

Paginated raw usage events for debugging and integrations.

| Param | Type | Description |
|-------|------|-------------|
| `limit` | number | Max rows (default `100`, max `1000`) |
| `cursor` | string | Opaque pagination cursor |
| `agent` | string | Filter by agent id |

### `POST /api/scan`

Triggers an immediate full or incremental rescan.

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

HTTP status codes: `400` validation, `404` not found, `500` internal.

---

## Configuration

Config file (created on first run):

```text
# Windows
%APPDATA%\xlab-token\config.json

# macOS
~/Library/Application Support/xlab-token/config.json

# Linux
~/.config/xlab-token/config.json
```

Example:

```json
{
  "host": "127.0.0.1",
  "port": 3737,
  "watch": true,
  "pricing": {
    "source": "bundled",
    "currency": "USD"
  },
  "agents": {
    "claude-code": { "enabled": true },
    "cursor": { "enabled": true },
    "codex": { "enabled": true },
    "copilot": { "enabled": false }
  },
  "paths": {
    "overrides": {}
  }
}
```

Environment variables (override file values):

| Variable | Meaning |
|----------|---------|
| `XLAB_TOKEN_HOST` | Bind host |
| `XLAB_TOKEN_PORT` | Bind port |
| `XLAB_TOKEN_DATA_DIR` | Data directory |
| `XLAB_TOKEN_NO_UI` | `1` to disable dashboard |

---

## Data model

### `UsageEvent` (logical schema)

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Stable hash of source + native id |
| `agent` | string | Canonical agent id (`claude-code`, …) |
| `model` | string \| null | Provider model id when known |
| `timestamp` | string | ISO-8601 UTC |
| `inputTokens` | number | Prompt / input tokens |
| `outputTokens` | number | Completion tokens |
| `cacheReadTokens` | number | Cache hits (if any) |
| `cacheWriteTokens` | number | Cache writes (if any) |
| `workspace` | string \| null | Project path when available |
| `sourcePath` | string | Local file the event was parsed from |
| `raw` | object \| null | Optional sanitized native fields |

### Storage

- Default: **SQLite** under the data directory
- Append-only event log + rollup tables for fast dashboard queries
- Idempotent ingest via `id` uniqueness

---

## Privacy & security

| Principle | Practice |
|-----------|----------|
| Local by default | Listens on `127.0.0.1` only |
| No account required | No signup, no telemetry required |
| Minimal content | Prefer token counters over message bodies |
| User-owned data | DB and exports stay on disk under `data-dir` |
| Explicit network | Optional price table updates only when user enables them |

**Recommendations**

- Do not bind to `0.0.0.0` on untrusted networks.
- Treat the local DB as sensitive if paths/workspace names are stored.
- Review agent source paths before enabling a parser.

---

## Development

```bash
git clone https://github.com/<org>/XLab_Token.git
cd XLab_Token
npm install
npm run dev          # API + UI with hot reload
npm test
npm run build
npm start            # production serve from dist
```

### Suggested package layout

```text
packages/
  cli/           # xlab-token binary
  core/          # scanners, parsers, pricing, store
  server/        # HTTP API
  web/           # localhost dashboard
```

### Scripts (conventional)

| Script | Purpose |
|--------|---------|
| `dev` | Local development server |
| `build` | Compile TypeScript / bundle UI |
| `test` | Unit + integration tests |
| `lint` | ESLint / Biome |
| `typecheck` | `tsc --noEmit` |

---

## Roadmap

- [ ] Core scanner framework + SQLite store
- [ ] First-party parsers (Claude Code, Cursor, Codex)
- [ ] Localhost dashboard (totals, charts, filters)
- [ ] Pricing table with offline snapshot
- [ ] Export JSON/CSV + `--json` CLI stats
- [ ] Plugin API for custom agent parsers
- [ ] Optional encrypted local DB

---

## Contributing

Contributions are welcome.

1. Fork the repository and create a feature branch.
2. Keep parsers pure and well-tested (fixture-based).
3. Prefer small, focused pull requests.
4. Follow Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, …

---

## License

MIT License — see [`LICENSE`](./LICENSE) when published.

---

## Disclaimer

XLab Token reads **local usage artifacts** produced by third-party tools. Those tools and their file formats are owned by their respective vendors and may change without notice. Token counts and cost estimates are **best-effort** and may differ from provider billing dashboards.
