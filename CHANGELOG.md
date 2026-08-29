# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-08-29

### Added
- macOS/Linux support: `install.sh` / `install-loopctl.sh` mirror the Windows `.bat` entries and ship in the npm package.
- Real per-agent stats on subagent rows: TPS, live context %, cumulative output and cost are computed from the agent's own transcript (`<project dir>/<session id>/subagents/agent-<task id>.jsonl`) — works on builds where the payload's `tokenCount`/`tokenSamples` stay 0 for whole runs.
- Live activity label (`task.label`, falling back to `description`) on subagent rows, updated every refresh tick.
- Opt-in payload capture for debugging: `touch ~/.claude/statusline-debug` appends every render's raw stdin payload to `~/.claude/statusline-payloads.log` (size-capped ~512KB). Delete the flag file to stop.
- Main-line TPS age marker: `TPS:N (Xm ago)` once the underlying message is over 2 minutes old, so a stale figure reads as "waiting" rather than a frozen display.

### Fixed
- Installs on macOS/Linux with nvm/volta: `--install` now registers the absolute Node binary path (`process.execPath`) in `settings.json` instead of a bare `node` that non-interactive statusLine/hook shells cannot resolve.
- Main-line `TPS`/`out`/`cache` no longer show a subagent's message when one happens to complete last — sidechain (`isSidechain: true`) entries are skipped on the main line while still counting toward the session-wide Σ totals.
- Subagent rows no longer render `tok:0(0%)` / `0.0tok/s` when Claude Code reports no token data — those fields are omitted instead of reading as a frozen display.

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

[1.1.0]: https://github.com/tangjianfang/claudecode-statusline/releases/tag/v1.1.0
[1.0.2]: https://github.com/tangjianfang/claudecode-statusline/releases/tag/v1.0.2
[1.0.1]: https://github.com/tangjianfang/claudecode-statusline/releases/tag/v1.0.1
[1.0.0]: https://github.com/tangjianfang/claudecode-statusline/releases/tag/v1.0.0