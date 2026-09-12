# Changelog

All notable changes to TokenLab are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.6] — 2026-09-13

### Added
- **Live-rate engine** — rewritten rate computation (`live-rate.ts`) with faster
  per-period queries and a period filter index (sorted events + parallel ms
  index for O(log n) range scans).
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
