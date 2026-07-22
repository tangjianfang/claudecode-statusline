# cc-statusline

Custom status line scripts for [Claude Code](https://claude.ai/code), plus an optional auto-continue loop tool. Both are single-file, zero-dependency (Node.js built-in modules only).

- **`statusline.js`** — shows model name, output speed (TPS), token usage, cost, git branch, context-window usage, rate-limit usage, and more. The same script also works as `subagentStatusLine`, rendering one row per subagent (speed / tokens / context share).
- **`loopctl.js`** — turns Claude Code's `Stop` hook into a per-project, toggleable "auto-continue" loop. When enabled, every time Claude is about to stop it gets intercepted and fed a prompt like "What is the next task? Plan and execute it." so it keeps working, up to a round cap. **Off by default, and only active in projects where you explicitly run `loopctl on`** — other projects are unaffected.

## What it looks like

The main status line renders two lines:

```
[Sonnet 5] 📁 my-project 🌿 main PR#123👀 ctx:42%
TPS:38.2 out:1.2k cache:15k Σ↓120k ↑8.4k +120/-15 ~cost:$0.31 dur:2m 14s 5h:24% 7d:81% ⚡fast 🧠think eff:high
```

- **Line 1** — model / current working directory (a clickable `file://` link) / git branch (when the origin remote resolves to GitHub/GitLab/Bitbucket, the branch name is also a clickable link to that branch's browse page on the remote) / associated PR number and review state / session name (if set) / auto-loop badge `🔁loop:2/8` (only when `loopctl on` is active in the current project) / context-window usage percentage.
- **Line 2** — output speed of the last response (TPS), output token count, cache-hit token count, session-wide input/output token totals (`Σ↓/↑`), lines changed (`+added/-removed`), cumulative cost (`~cost`, a client-side estimate that may differ from the actual bill), cumulative duration, Pro/Max rate-limit usage (5-hour / 7-day windows, changing color past 70%/90%), and status flags for fast mode / extended thinking / reasoning effort / vim mode (each field is omitted when its value is absent).

The subagent status line (`subagentStatusLine`) renders one row per task:

```
Explore running 266.7tok/s tok:1.2k(1%) eff:high
```

Claude Code's stdin JSON for the status line does not include token/timing data, so the script reads the JSONL transcript file pointed to by `transcript_path`, parsing the `usage` field of each assistant message line by line to compute TPS and cumulative totals. Subagent row speed comes from the task's own `tokenSamples` / `tokenCount` + `startTime` (`tokenSamples` is not officially documented, so the script parses it defensively and falls back to a coarse `tokenCount / elapsed-time` estimate when it can't extract usable samples).

## Install

```bash
# From npm (installs cc-statusline, loopctl, pricing-updater as global commands)
npm install -g @tangjianfang/claudecode-statusline

# Or from GitHub
git clone https://github.com/tangjianfang/claudecode-statusline.git
```

After installing from npm, the three global commands (`cc-statusline`, `loopctl`, `pricing-updater`) are ready to use. The status line and loopctl still need to be wired into Claude Code's settings — see [Installing the status line](#installing-the-status-line) and [Install](#install-1) (loopctl) below. A pre-npm-published, identical package is also available under the shorter name `@tangjianfang/cc-statusline`.

## Installing the status line

```bash
node statusline.js --install
```

This will:

1. Copy `statusline.js` to `~/.claude/statusline.js` (prompting before overwriting if an existing copy differs).
2. Update the `statusLine` and `subagentStatusLine` fields in `~/.claude/settings.json` to point at the copied script (the script tells the two input shapes apart at runtime); if either field is already set to something else, it prompts independently before overwriting.

Reopen Claude Code after installing to see the new status line.

You can also use the npm script:

```bash
npm run install-statusline
```

On Windows you can instead double-click `install.bat` (it checks that `node` is on PATH, then runs `statusline.js --install`).

### Running / debugging manually

The status line script reads a JSON payload from stdin (provided by Claude Code) and writes formatted text to stdout:

```bash
echo '{}' | node statusline.js
```

Pass a real payload (one that includes `transcript_path`) to see the full TPS/token stats.

## Auto-continue loop (loopctl)

`loopctl.js` is a standalone global tool that keeps Claude Code going after it finishes a response — automatically planning and executing the next step — up to a round cap you set. It builds on Claude Code's `Stop` hook: each time Claude is about to stop, the hook checks whether the current project has the loop enabled; if so and the round cap isn't reached, it returns `{"decision":"block","reason":"..."}`, making Claude treat the `reason` text as a new instruction and continue.

**Off by default, and toggled per project (by current working directory)** — state lives at `<project>/.claude/loop-state.json`. Installing the tool does not affect other projects or global behavior; you must explicitly run `loopctl on` inside a project for it to take effect there.

### Install

```bash
node loopctl.js --install
```

This copies `loopctl.js` to `~/.claude/loopctl.js` and appends an entry to `~/.claude/settings.json`'s `hooks.Stop` array pointing at it (it does not overwrite any other Stop hooks you already have). You can also use `npm run install-loopctl`, or on Windows double-click `install-loopctl.bat`.

### Usage

Inside the project directory where you want the loop active:

```bash
# Enable the loop: up to 8 rounds, auto commit + push each round (uses the next-step preset by default)
loopctl on --max 8 --push

# Pick a prompt "theme" via a built-in preset instead of typing a long prompt each time
loopctl on --max 5 --preset improve

# Fully customize the prompt injected each round
loopctl on --max 5 --prompt "Keep improving this project — proactively find something worth improving and do it"

# --preset and --prompt together: --prompt overrides --preset's text
# (use a preset as a starting point, then tweak with --prompt)

# List all built-in presets and their text
loopctl presets

# Disable the loop
loopctl off

# Show the loop state for the current project
loopctl status
```

Once installed as a global tool (`node loopctl.js --install`), the commands above work as plain `loopctl ...` (provided `~/.claude` is on your PATH, or use `node ~/.claude/loopctl.js ...` otherwise).

### Flags

| Flag | Description |
|---|---|
| `--max N` | Auto-continue for at most N rounds (default 8). **Claude Code has a built-in protection that force-releases a Stop hook after it blocks 8 consecutive times without progress**; setting `--max` higher than 8 means the loop may be cut short by the system before reaching your cap. To raise the ceiling, set the `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` environment variable. |
| `--push` / `--no-push` | Whether to run `git add -A && git commit && git push` each round (default off). **Pushes directly to the currently checked-out branch**, including `main` — there is no dedicated-branch safety net; assess the risk yourself. |
| `--preset <name>` | Select the per-round prompt from a built-in template (see table below); an unknown name errors out and suggests running `loopctl presets`. |
| `--prompt "..."` | Fully customize the per-round prompt; takes precedence over `--preset` (last-parsed wins). |

### Built-in presets (`--preset`)

| Name | Purpose | Prompt |
|---|---|---|
| `next-step` (default) | Generic "keep going" | What is the next task? Plan and execute it. |
| `find-bugs` | Proactively find and fix bugs | Proactively check the current code for potential bugs or logic issues. Fix any you find and explain the fix. |
| `improve` | Proactively find improvements and make one | Proactively look for things in the project that can be improved (code quality, readability, performance, docs, test coverage, etc.). Pick one valuable improvement and make it. |
| `tests` | Add / fix tests | Check whether the project's tests are complete and passing. Add missing test cases or fix failing tests. |
| `docs` | Keep docs in sync with code | Check whether the docs (README, comments, etc.) are consistent with the current code. Update anything outdated or missing. |
| `refactor` | Safe refactoring | Find a piece of code that can be safely simplified or refactored, and do so without changing behavior. |

These are defined as the `PRESETS` constant at the top of `loopctl.js`. To add your own, add an entry in the source, or use `--prompt` for a fully custom prompt.

## npm scripts

There is no test framework or linter. The package exposes a few convenience scripts:

| Script | What it does |
|---|---|
| `npm run check` | Syntax-check all three scripts (`node --check`). |
| `npm run install` | Install both the status line and loopctl (runs the two `--install` steps). |
| `npm run install-statusline` | Install only the status line (`statusline.js --install`). |
| `npm run install-loopctl` | Install only loopctl (`loopctl.js --install`). |
| `npm run update-pricing` | Fetch current rates and merge them into `~/.claude/pricing.json`. |
| `npm run pricing:list -- minimax` | Print litellm keys/rates matching a pattern, write nothing (defaults to all if no pattern). |
| `npm run presets` | List loopctl's built-in `--preset` prompts. |
| `npm run demo` | Render the main status line against an empty payload (smoke test). |
| `npm run demo:subagent` | Render a sample subagent row (smoke test). |

> Note: `loopctl on` / `off` / `status` are **deliberately not** npm scripts. They act on `process.cwd()`, and `npm run` always runs with the package directory as cwd — so a `npm run loopctl:on` would toggle the loop for *this repo*, not whatever project you meant. Run `loopctl on` directly inside the target project instead.

## Dependencies

No third-party dependencies — only Node.js built-in modules (`fs`, `path`, `os`, `readline`, `child_process`, `url`). Node.js ≥ 16.

## Cost estimation

The `~cost:` figure is computed by the script itself from the transcript's token counts, not read from Claude Code's client estimate. The algorithm is public and lives at the top of `statusline.js`:

```
cost = freshInput/1M × p.in
     + output/1M      × p.out
     + cacheRead/1M   × p.cacheRead
     + cacheCreate/1M × p.cacheWrite
```

where `p` is a per-model pricing entry (USD per 1M tokens) looked up from a `pricing.json` table. The four token totals are accumulated session-wide while parsing the transcript (the same pass that produces `Σ↓`/`↑` and `cache:`).

**Why self-compute:** Claude Code's `data.cost.total_cost_usd` is priced at Anthropic's rates, which is wrong when you route to a third-party model via `ANTHROPIC_BASE_URL` (e.g. MiniMax). Computing from your own rate table makes the figure match what you actually pay.

**The pricing file:** the table lives in `pricing.json` — one file, the single source of truth. The repo ships a curated copy covering the canonical chat models of every mainstream provider (Anthropic, OpenAI, Google/Gemini, MiniMax, DeepSeek, Meta/Llama, Mistral, xAI/Grok, Cohere, Alibaba/Qwen) with all their versions. `statusline.js` reads the `pricing.json` that sits next to it; `--install` seeds `~/.claude/pricing.json` from that shipped copy (only if you don't already have one — it never overwrites your copy). So cost estimation works out of the box, and you can refresh or hand-edit the file anytime. Shape:

```json
{
  "MiniMax-M3": { "in": 0.3, "out": 1.2, "cacheRead": 0.06, "cacheWrite": 0 }
}
```

Keys match first by exact model name, then by longest case-insensitive substring (so `claude-sonnet-5-20250514` matches `claude-sonnet-5`). When no entry matches the current model, the script falls back to `data.cost.total_cost_usd` and labels it `~cost?:` to flag that it's the untrusted client estimate rather than a self-computed figure. To add or fix a rate, just edit `~/.claude/pricing.json` (or the repo's `pricing.json` if you're maintaining this project) — the status line picks it up on the next render.

### Refreshing rates manually

`pricing-updater.js` fetches live rates from the community-maintained [litellm price table](https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json) (each entry is sourced from the provider's official pricing page — Anthropic and MiniMax do not publish a JSON pricing API, only HTML, so this is the closest thing to an official real-time source). It extracts the **canonical chat models from every mainstream provider** — Anthropic (Claude), OpenAI (GPT/o-series), Google (Gemini), MiniMax, DeepSeek, Meta (Llama), Mistral, xAI (Grok), Cohere (Command), and Alibaba (Qwen) — with all their versions, converts per-token rates to per-million, and merges them into `~/.claude/pricing.json`. Hoster/regional duplicates (Bedrock, Vertex, OpenRouter, Azure, etc.) and non-chat models (embeddings, speech, image) are filtered out, and each model is deduped to one entry. The status line itself never hits the network — it only reads the cached file, so renders stay fast and never block.

```bash
node pricing-updater.js                 # fetch all mainstream providers, merge into ~/.claude/pricing.json
node pricing-updater.js --model KEY     # also include a specific litellm key (repeatable)
node pricing-updater.js --list minimax  # print matching keys + rates, write nothing
node pricing-updater.js --overwrite     # replace the target file entirely instead of merging
node pricing-updater.js --out pricing.json --overwrite   # maintainer: refresh the repo's shipped copy
```

Run it manually whenever you want fresh rates — the status line picks up the new `pricing.json` on its next render. There is **no scheduled task and no auto-update**: updating pricing is an explicit, user-initiated action, since silently rewriting rate data in the background (with the network and trust risks that entails) is not something this tool does for you.

**Maintaining this repo's `pricing.json`:** the shipped `pricing.json` is just a snapshot — refresh it with `node pricing-updater.js --out pricing.json --overwrite`, eyeball the diff, commit, and users get the new rates on their next `--install` (new installs are seeded from it; existing installs keep whatever the user has, since `--install` never overwrites their copy).

## Known limitations

- **TPS is not real-time** — the main status line only re-runs when a new assistant message completes, `/compact` finishes, the permission mode changes, etc. The number does not tick during a single response's generation; it always reflects the speed of the *previous completed* response. For more frequent refresh, add something like `"refreshInterval": 2` to the `statusLine` config in `~/.claude/settings.json`.
- **TPS reads low** — the denominator is the time from "previous user/tool_result timestamp" to "assistant message completion", which includes network round-trips and time-to-first-token rather than pure decode time. The figure is systematically lower than the model's true token-generation speed, especially for short replies.
- **`cost.total_cost_usd` is an estimate, not the bill** — and it's priced at Anthropic's rates even when you route to a third-party model (e.g. MiniMax via `ANTHROPIC_BASE_URL`), so the script does **not** display it verbatim. Instead it self-computes cost from the transcript's token counts times a public, editable pricing table (see [Cost estimation](#cost-estimation) below). The self-computed figure shows as `~cost:`; when the current model has no pricing entry it falls back to `total_cost_usd` shown as `~cost?:` to flag that it's the untrusted client estimate. Both are estimates — hence the `~` prefix.
- **Subagent `tokenSamples` is undocumented** — the script parses it defensively (looking for `{timestamp, tokens}`-like structures) and falls back to a coarse `tokenCount / elapsed-time` estimate when no usable data is found. It is labeled `tok/s` (throughput) rather than `TPS` because it may not reflect pure generation speed.
- **Branch links support GitHub / GitLab / Bitbucket only** — the link is built from `workspace.repo.host/owner/name` (repo info Claude Code parses from the `origin` remote) using fixed URL shapes per host. Self-hosted Git servers and other platforms are not recognized; in those cases the branch name renders as plain text rather than a guessed-wrong link.
- **loopctl is an open-ended autonomous loop** — the round cap only prevents infinite runs; it does not check whether "the task is actually done" or "the changes are what you wanted". Don't leave it running unattended for long stretches.
- **loopctl's `--max` is bounded by Claude Code's own Stop-hook protection** — Claude Code force-releases a Stop hook after 8 consecutive blocks without progress, so `--max` above 8 may be cut short by the system. Raise the ceiling with the `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` environment variable.
- **loopctl's `--push` pushes directly to the current branch** (including `main`), with no "dedicated branch only" guard. If the loop produces undesirable changes they go straight into the remote history; try it on a dedicated branch first. Push failures (no remote configured, network issues, etc.) are caught and folded into the `reason` text returned to Claude — they don't abort the loop, but the local commit still lands.

## Notes

The end of `statusline.js` contains an optional, environment-specific integration: if the `AUTOCLAUDE_BROADCAST` environment variable is set to a `broadcast.js` module path, the current session info is broadcast to an "AutoClaude" sensor. This logic is wrapped in try/catch and silently skips when the variable is unset or the path is missing, so it never affects the status line output.