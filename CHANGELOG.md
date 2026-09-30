# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-09-30

### Removed
- **loopctl** (the v1.x Stop-hook auto-continue loop) — Claude Code now ships native `/goal`, which replaces it. Deleted `loopctl.js`, `install-loopctl.bat` / `install-loopctl.sh`, the `loopctl` bin, and the `install-loopctl` / `presets` npm scripts. The npm `postinstall` now best-effort cleans up existing installs: deregisters the loopctl `Stop` hook from `~/.claude/settings.json` (other Stop hooks untouched) and deletes `~/.claude/loopctl.js` + `~/.claude/loop-state.json`. Per-project `.claude/loop-state.json` files, if any, are inert and safe to delete. The status line's `🔁loop:` badge and its read-only loop-state peek are gone with it.
- The legacy self-dependency on the v1 alias package (`@tangjianfang/cc-statusline ^1.0.1`): under package managers that install dependencies of global packages (Bun), it pulled the old v1.0.1 package — with its v1 install scripts, including `loopctl` registration — into `node_modules`; `bun pm trust --all` would then have executed those v1 scripts and re-installed the removed loopctl.

### Added
- New status-line segments fed by current Claude Code payloads (v2.1.251+ where noted), all conditional:
  - `pc:87%(5m)` — prompt-cache health: hit ratio + TTL, `(cold)` when the cache is rebuilding (`prompt_cache.warm`), green ≥80% / yellow ≥50% / red below.
  - `5h:24% (2h06m)` / `7d:81%` — rate-limit usage with a compact time-to-reset from `rate_limits.*.resets_at` (suppressed when absent, past, or >48h out).
  - `sp:45%` — spend-limit usage (`rate_limits.spend_limit`, can exceed 100%), same color thresholds.
  - `🌳wt:<name>` — worktree name (`data.worktree.name`), so you can tell worktree sessions apart by more than their branch.
  - `🤖<name>` — agent name in `--agent` sessions (`data.agent.name`).
  - `ctx:23%/1M` — context usage now also shows the total window size (`context_window.context_window_size`), which matters again with 1M-context models.
  - `MR#123` — GitLab merge requests render as `MR#` via `pr.kind` (was `PR#` for both).
  - `style:<name>` — non-default output style (`output_style.name`).
  - `v2.1.258` — Claude Code version, dim, at the end of line 2 (debugging aid).
- Pricing coverage for **Z.ai/GLM** (canonical `zai/*` keys sourced from Z.ai's official pricing page — covers `glm-5.3`, `glm-5.3-flash`, `glm-5-code`, …, so third-party routing via `ANTHROPIC_BASE_URL` prices correctly) and **Moonshot/Kimi** (`kimi-k3`, `kimi-k2.7-code`, …).
- `pricing.json` refreshed from today's litellm table (286 entries): latest Anthropic (`claude-opus-5-5`, `claude-sonnet-5-5`, …), OpenAI (`gpt-5.5-cyber`, `gpt-6.1-sol`, …), Gemini, MiniMax M3, Grok 4.20 line, GLM 5.x, Kimi, DeepSeek, Qwen.
- **Bun / pnpm / Yarn support** (all verified against real installs): npm and Yarn Classic wire up automatically; Bun needs `bun pm -g trust @tangjianfang/claudecode-statusline` after the add (Bun blocks lifecycle scripts by default), pnpm v10+ needs `pnpm approve-builds -g`; Yarn Berry removed `global add` entirely — use it as a project dependency and run `cc-statusline --install` once. The installer resolves the real Bun binary (`Bun.execPath` → `BUN_INSTALL/bin` → PATH scan) and registers it as the `statusLine` interpreter; it never registers Bun's temporary `node` compatibility shim (`…\Temp\bun-node-<hash>\node.exe`), which `process.execPath` points at inside lifecycle scripts and which would break the status line once the OS cleans the temp dir.

### Fixed
- `pricing-updater` with no arguments now performs its documented default action (fetch + merge into `~/.claude/pricing.json`) instead of printing help — the docs and `npm run update-pricing` always promised the merge; the help-first behavior silently broke that path.
- Under Bun, `--install` no longer registers Bun's throwaway temp `node` shim as the statusLine interpreter (it pointed into the OS temp dir and would break on temp cleanup) — see the Bun support entry under Added.

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