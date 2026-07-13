# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.5] - 2026-07-13

### Changed
- Align offline bundled model rates with official vendor pricing (Anthropic, OpenAI, xAI, DeepSeek, GLM)
- Expand Model catalog with seen models, bundled aliases, and provider icons

### Fixed
- Agent brand icons (ZCode, Open Code Review, Windsurf, etc.)
- Codex plugin fixture noise that faked “Just now” usage
- Chart timeline labels across multi-year ranges
- UI mojibake / encoding issues

## [1.0.4] - 2026-07-13

### Added
- Windows autostart with crash recovery and graceful shutdown
- Windows login autostart and system tray icon
- GitHub Gist backup includes full project usage
- Responsive two-column Settings layout on wide screens
- Full project export/import with events and mirrors

### Changed
- Prefer daily aggregates over per-request history storage
- Harden backup mirror path checks against traversal
- Redraw Settings gear with clean Heroicons cog outline

### Fixed
- Various bug fixes and improvements

## [1.0.3] - 2026-07-12

### Added
- Initial release with core functionality
- Multi-agent support (Cursor, Grok, Windsurf, Codex, Claude Code, etc.)
- Token usage tracking and cost calculation
- Dashboard UI with statistics
- Background scanning and monitoring
- Local-first data storage

## [1.0.2] - 2026-07-11

### Added
- Basic CLI interface
- HTTP server with dashboard
- Agent scanning and parsing
- Cost tracking with OpenRouter pricing

## [1.0.1] - 2026-07-10

### Added
- Initial project setup
- Basic structure and configuration
