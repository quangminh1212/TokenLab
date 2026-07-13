# Attribution

XLab Token is an **independent** local-first project. Feature ideas and local data-path conventions were informed by the open-source ecosystem below. No proprietary code was copied; parsers and the cost engine are original TypeScript implementations.

## Reference projects

| Project | License | What we learned |
|---------|---------|-----------------|
| [junhoyeo/tokscale](https://github.com/junhoyeo/tokscale) | Check repo | Multi-agent scanning, TUI/dashboard, LiteLLM-style pricing, unified usage model across 30+ clients |
| [getagentseal/codeburn](https://github.com/getagentseal/codeburn) | MIT | Localhost web dashboard, provider path table, cost × token buckets, JSON CLI exports |
| [ccusage/ccusage](https://github.com/ccusage/ccusage) | Check repo | Claude Code / Codex / OpenCode JSONL daily–monthly reports, multi-source CLI UX |
| [LiteLLM model prices](https://github.com/BerriAI/litellm) | MIT | Public model rate table shape (input/output/cache per 1M tokens) |

## Design principles borrowed

1. **Local-only by default** — read agent files already on disk; bind `127.0.0.1`.
2. **Normalize everything** — map heterogeneous logs into one `UsageEvent` schema.
3. **Tokens + spend** — never report tokens without optional estimated cost.
4. **Detect then parse** — `doctors` / `/api/agents` surface which tools exist on the machine.
5. **Honest estimates** — mark unknown models and estimated sources explicitly.

## Disclaimer

Third-party tool names, paths, and formats belong to their vendors and may change without notice.
