# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] - 2026-07-23

### Changed
- Expanded npm `keywords` from 9 to 19 (added `auto-continue`, `agentic-loop`, `stop-hook`, `claude-hooks`, `cost-tracking`, `token-counter`, `tps`, `pricing`, `litellm`, `rate-limit`) for better discoverability on npmjs.com.
- Added 15 GitHub repo topics (was empty) covering the same surface plus the broader ecosystem tags (`claude-code`, `statusline`, `anthropic`, `cli`, `terminal`).

## [1.0.1] - 2026-07-23

### Added
- `scripts/postinstall.js` — npm `postinstall` now wires everything automatically on `npm install -g`:
  - copies `statusline.js` + `loopctl.js` to `~/.claude/`
  - registers `statusLine`, `subagentStatusLine`, and `hooks.Stop` in `~/.claude/settings.json`
  - seeds `~/.claude/pricing.json` from the bundled copy if absent
- `--yes` flag on `statusline.js --install` and `loopctl.js --install` so the postinstall script can auto-confirm overwrite prompts (manual installs are unchanged — they still prompt).
- `.github/workflows/check.yml` — minimal CI that runs `npm run check` on push to `main` and on PRs.

### Changed
- Simplified the README: install + example + loopctl quick start moved to the top, with all detail (cost estimation, pricing-updater flags, full flag tables, npm scripts, known limitations) tucked into a Reference section.

## [1.0.0] - 2026-07-23

### Added
- Initial public release.
- `statusline.js` — main-session status line (model, TPS, tokens, cost, git branch, context %, rate-limit usage) and subagent-row status line.
- `loopctl.js` — per-project, opt-in auto-continue loop built on Claude Code's `Stop` hook. Off by default everywhere; enable per-project with `loopctl on --max 8 --push`.
- `pricing-updater.js` — fetches mainstream-provider rates from the community-maintained litellm price table, merges into `~/.claude/pricing.json` (manual only, no scheduled task).
- `pricing.json` — single source of truth for cost estimation, covers the canonical chat models of Anthropic, OpenAI, Google/Gemini, MiniMax, DeepSeek, Meta/Llama, Mistral, xAI/Grok, Cohere, Alibaba/Qwen.
- Both npm packages published under @tangjianfang/claudecode-statusline (canonical) and @tangjianfang/cc-statusline (shorter alias).

[1.0.2]: https://github.com/tangjianfang/claudecode-statusline/releases/tag/v1.0.2
[1.0.1]: https://github.com/tangjianfang/claudecode-statusline/releases/tag/v1.0.1
[1.0.0]: https://github.com/tangjianfang/claudecode-statusline/releases/tag/v1.0.0