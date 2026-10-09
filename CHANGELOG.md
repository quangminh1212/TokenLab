# Changelog

All notable changes to TokenLab are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **LiteLLM cache is now scanned and counted correctly** (the LiteLLM bucket
  reported ~4.50 B cache-read tokens of the ~8.50 B the VPS mirror actually
  served; **47.2 % of all cache was dropped**). Three independent causes, each
  verified against the live mirror and against LiteLLM's own source, are
  documented with file/line citations in `docs/litellm-cache-accounting.md`:
  - **LiteLLM's prompt count includes the cache hit.**
    `litellm/cost_calculator.py` L455-460 states the invariant —
    *"prompt_tokens already INCLUDES cached_tokens"* — and
    `proxy/spend_tracking/spend_tracking_utils.py` L762-765 maps
    `prompt_tokens_details.cached_tokens` onto `cache_read_input_tokens`, which
    the VPS UI exports as the row's `cachedTokens`. TokenLab kept both columns,
    so `totalTokens` counted the hit twice and overstated the prompt by 4.5 B.
    The litellm parser now carves the hit out of the prompt, so
    `inputTokens + cacheReadTokens === promptTokens` exactly.
  - **Overlapping `byModel` views were treated as additive.** The export emits one
    model view twice under different keys with the same `rawModel`, and the day
    cache was compared against only the winning view, so the "remainder" restated
    the other half as an extra `unattributed` row. The old guard against that
    (`remIn > 0 || remOut > 0`) only fired when `byModel` landed exactly on the
    day; it routinely overshoots instead, leaving `remIn` clamped to 0. The
    remainder now carries the real cache remainder.
  - **The high-water guard reverted every fix on the next save.**
    `enforceMonotonicAgentDays` weighed router rollups by
    `inputTokens + outputTokens` only. Carving the hit out of the prompt *moves*
    tokens from one column to the other without changing the day's real usage, so
    a corrected row looked "thinner" than the stale one that still counted the hit
    in both — and the stale row won on request count besides. The weight now
    measures the whole prompt account (`input + cacheRead + output`), and an
    exact-envelope tiebreak prefers the snapshot reporting more cache.
- LiteLLM day rollups no longer invent tokens the source never billed: the parse
  is exactly additive per request, matching LiteLLM's own
  `generic_cost_per_token` decomposition
  (`(prompt − cacheRead − cacheWrite) × input + cacheRead × cacheReadRate + write × writeRate`).

### Added
- **`cacheBilledTokens` / `cacheFreeTokens`** on every stats bucket, so
  `CACHE $ 0.00` is distinguishable from "cache was never scanned". LiteLLM's
  mirrored models all set `cacheReadPer1M === inputPer1M`, so their cache hits
  carry no discount and bill $0.00 by design — that is now labelled rather than
  looking like a missing scan.
- `docs/litellm-cache-accounting.md` — LiteLLM's exact cache-token and cost
  formula with verbatim source citations, and the mirror's field semantics.
- **Configurable scan frequency** — Settings → **Scanning** lets you set the
  background scan cadence (1/2/5/10/15/30/60 min), the full all-agent rescan
  interval (1/3/6/12/24 h), and toggle background scanning entirely. Stored as
  `scan.{intervalMinutes,fullIntervalMinutes,periodicEnabled}` in `config.json`
  and applied without a server restart.
- `scanIntervalMinutes` / `scanFullIntervalMinutes` / `scanPeriodicEnabled` /
  `lastScanAt` in `GET /api/health` so the UI shows the resolved cadence.

### Changed
- **Default background scan cadence is now 1 hour for both the light scan and the
  full all-agent pass** (was 5 min light / 6 h full). Scanning walks agent logs on
  disk, so the frequent light pass was the largest recurring CPU/disk cost; both
  values remain configurable in Settings → **Scanning**.
- **Grok session events are now cached per directory.** `parseGrokSession`
  re-derived events from four artifacts on every tick and never scored a hit,
  costing ~3.2s per scan for only 317 events across 109 sessions. Caching the
  derived events — keyed on a stamp of all four artifacts, so an append to any of
  them still invalidates the entry — cuts a warm scan to ~40ms.
- `cachedEventsForFile` accepts an optional caller-supplied `signature`, so a
  parser can cache a product derived from several files instead of one.
- Settings → **Scanning** hint text is now rendered from the server-resolved
  cadence in `GET /api/health`, falling back to `/api/config` rather than to the
  `<select>` DOM. A failed or slow config read used to relabel the saved cadence
  as the default until the next reload.
- Remote mirror sync still runs every minute.
- Settings page decluttered: General and Cost estimation merged into one
  **Preferences** card, the Gist and config-path details moved behind
  disclosures, and row spacing tightened so the page fits one screen. The
  **Rescan** button moved from System to **Scanning**, where it belongs.

## [1.0.6] — 2026-09-13

### Added
- **Live-rate engine** — rewritten rate computation (`live-rate.ts`) with faster
  per-period queries and a period filter index (sorted events + parallel ms
  index for O(log n) range scans).
- **Node engines requirement raised to `>=22.5.0`** — the parser stack reads
  agent state DBs via the built-in `node:sqlite` module (Node 22.5+).
- **Claude Code cache reconciliation** — fresh source rows now replace
  pre-dedupe cache rows (`replaceFreshAgentSourceEvents`), fixing historical
  over-counting from one-id-per-content-block cache versions.
- **openclaw best-of-both parser** — origin snapshot semantics
  (`readGrokUsageSnapshot`, `hadRealUsage` double-count guard, pruned-session
  recovery from `client-state/session-meta.json`) combined with
  `parsePersistedUsage` for legacy `turns[]` usage.json exports;
  `modelFromUsage` now reads `primaryModelId` / `primary_model_id`.
- **Compact full backups** — full exports now use the same compact Gist-style
  rollups (`buildFullBackup` formatVersion 3) instead of raw request rows.
- **Codex cached tokens** — `extractTokenBuckets` reads
  `cached_input_tokens` / `cache_write_input_tokens` fields.
- New test suites: `cache-reconciliation`, `claude-code-parser` (128 tests total).

### Changed
- Dashboard period tab switches are instant via the period index (no re-aggregation).
- Scan-cache load/save and period queries optimized; mid-scan rebuilds are throttled.
- "Recent events" renamed to "Recent requests"; estimated-tilde hidden on model names.
- Router/source-path rollup collapsing runs once at final rebuild instead of per agent.

### Fixed
- openclaw: mono high-water no longer restores residual ghost rows; real usage always
  wins over residual estimates; stable residual ids stop out=0 ghost estimates.
- Claude Code: user/metadata rows can no longer shadow assistant usage rows sharing
  a UUID; nested `cache_creation` reads without double-counting.
- Hermes: snapshot double-count fixed; XLab gateway priced fairly.
- openclaw: null API root no longer crashes the models parser.
- Hour-bucket backup rollup test pinned to a fixed timestamp (was flaky across
  wall-clock minute boundaries).

### Security / Ops
- Gist restore rollups skip already-imported rollup rows from other machines
  (no re-bucketing); machine ids sanitized in export metadata.

## [1.0.5] — 2026-08-16

### Changed
- Period tab switches instant via period index; scan-cache load/save optimization.
- Full agent scan speedups (token estimate, I/O, GC).

## [1.0.3] — 2026-08-06

### Fixed
- Mono high-water Grok residual ghosts; VBS StartServe quoting; anti-kill + GC +
  model double-count fixes.

## [1.0.2] — 2026-08-05

### Added
- openclaw Cloud dashboard usage tracking.

## [1.0.1] — 2026-07-30

### Fixed
- Gateway pricing, snapshot double-count, early stability fixes.

## [1.0.0] — 2026-07-29

### Added
- Initial public release: local-first token usage & cost tracker for AI coding
  agents (Cursor, openclaw, Windsurf, Codex, Claude Code, and more) with localhost
  dashboard, CLI, HTTP API, Gist backup/restore, and pricing engine.
