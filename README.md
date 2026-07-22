# cc-statusline

Custom status line for [Claude Code](https://claude.ai/code), plus an optional auto-continue loop. Single-file Node.js scripts, zero dependencies (built-ins only).

- **`statusline.js`** — model, output TPS, tokens, cost, git branch, context %, rate-limit usage. Also renders one row per subagent.
- **`loopctl.js`** — turns Claude Code's `Stop` hook into a per-project, opt-in "keep going" loop. **Off everywhere by default**; you enable it per-project with `loopctl on`.

## Install

```bash
npm install -g @tangjianfang/claudecode-statusline
```

The `postinstall` hook automatically:

- copies `statusline.js` + `loopctl.js` to `~/.claude/`
- registers them in `~/.claude/settings.json` (`statusLine`, `subagentStatusLine`, `hooks.Stop`)
- seeds `~/.claude/pricing.json` if missing

Restart Claude Code. Done.

The same package is also published under the shorter name `@tangjianfang/cc-statusline`.

## What it looks like

Two lines in the status bar:

```
[Sonnet 5] 📁 my-project 🌿 main PR#123👀 ctx:42%
TPS:38.2 out:1.2k cache:15k Σ↓120k ↑8.4k +120/-15 ~cost:$0.31 dur:2m 14s 5h:24% 7d:81% ⚡fast 🧠think eff:high
```

The branch name is a clickable link to that branch's page on the remote (GitHub / GitLab / Bitbucket) when the `origin` resolves; on other hosts it stays plain text. Subagent rows render like:

```
Explore running 266.7tok/s tok:1.2k(1%) eff:high
```

## Auto-continue loop (loopctl)

Off everywhere by default. To use it in a project:

```bash
cd /path/to/project

loopctl on --max 8 --push     # enable: up to 8 rounds, auto-commit + push each round
loopctl off                   # disable
loopctl status                # show current state
loopctl presets               # list built-in prompts (find-bugs, improve, tests, ...)
```

Built-in presets for `--preset <name>`: `next-step` (default), `find-bugs`, `improve`, `tests`, `docs`, `refactor`. For a fully custom prompt, use `--prompt "your text here"`.

---

## Reference

### Manual / GitHub install

If you'd rather skip npm (or want fine-grained control over what gets overwritten):

```bash
git clone https://github.com/tangjianfang/claudecode-statusline.git
cd claudecode-statusline
node statusline.js --install
node loopctl.js --install
```

Each `--install` runs the same y/n prompts as before — handy if you want to keep an existing file or setting.

### Cost estimation

The `~cost:` figure is computed by the script itself from the transcript's token counts (split into fresh input / output / cache-read / cache-creation, accumulated session-wide), times a per-model pricing table that lives in `pricing.json`:

```
cost = freshInput/1M × p.in
     + output/1M      × p.out
     + cacheRead/1M   × p.cacheRead
     + cacheCreate/1M × p.cacheWrite
```

**Why self-compute:** Claude Code's `data.cost.total_cost_usd` is priced at Anthropic's rates, which is wrong when you route to a third-party model via `ANTHROPIC_BASE_URL` (e.g. MiniMax).

**The pricing file:** `pricing.json` is the single source of truth — one file, shipped with the repo and seeded into `~/.claude/pricing.json` on install (only if it doesn't already exist; never overwrites your copy). It covers the canonical chat models of every mainstream provider: Anthropic, OpenAI, Google/Gemini, MiniMax, DeepSeek, Meta/Llama, Mistral, xAI/Grok, Cohere, Alibaba/Qwen.

Key format:

```json
{
  "MiniMax-M3": { "in": 0.3, "out": 1.2, "cacheRead": 0.06, "cacheWrite": 0 }
}
```

`statusline.js` resolves a model by exact name first, then longest case-insensitive substring. When no entry matches, it falls back to `data.cost.total_cost_usd` shown as `~cost?:` to flag that it's the untrusted client estimate. Both figures are estimates — hence the `~` prefix; don't "fix" this by dropping the prefix.

#### Refreshing rates manually

```bash
node pricing-updater.js                                # fetch mainstream providers, merge into ~/.claude/pricing.json
node pricing-updater.js --model KEY                    # also include a specific litellm key (repeatable)
node pricing-updater.js --list [pattern]               # print matching keys + rates, write nothing
node pricing-updater.js --overwrite                    # replace target entirely instead of merging
node pricing-updater.js --out pricing.json --overwrite # maintainer: refresh repo's shipped copy
```

There is **no scheduled task and no auto-update** — updating pricing is an explicit, user-initiated action, since silently rewriting rate data in the background (with the network and trust risks that entails) is not something this tool does for you.

### loopctl flags (full)

| Flag | Description |
|---|---|
| `--max N` | Auto-continue for at most N rounds (default 8). **Claude Code force-releases a Stop hook after 8 consecutive blocks without progress**, so `--max` above 8 may be cut short. Raise the ceiling with `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`. |
| `--push` / `--no-push` | Run `git add -A && git commit && git push` each round (default off). **Pushes directly to the current branch, including `main`** — no dedicated-branch safety net. |
| `--preset <name>` | Pick the per-round prompt from a built-in template. Unknown names error out. |
| `--prompt "..."` | Fully customize the per-round prompt; takes precedence over `--preset` (last-parsed wins). |

#### Built-in `--preset` values

| Name | Prompt |
|---|---|
| `next-step` (default) | What is the next task? Plan and execute it. |
| `find-bugs` | Proactively check the current code for potential bugs or logic issues. Fix any you find and explain the fix. |
| `improve` | Proactively look for things in the project that can be improved (code quality, readability, performance, docs, test coverage, etc.). Pick one valuable improvement and make it. |
| `tests` | Check whether the project's tests are complete and passing. Add missing test cases or fix failing tests. |
| `docs` | Check whether the docs (README, comments, etc.) are consistent with the current code. Update anything outdated or missing. |
| `refactor` | Find a piece of code that can be safely simplified or refactored, and do so without changing behavior. |

### npm scripts

| Script | What it does |
|---|---|
| `npm run check` | Syntax-check all three scripts (`node --check`). |
| `npm run install` | Run both `--install` flows manually. |
| `npm run install-statusline` | Install only the status line. |
| `npm run install-loopctl` | Install only loopctl. |
| `npm run update-pricing` | Fetch current rates and merge into `~/.claude/pricing.json`. |
| `npm run pricing:list -- minimax` | Print litellm keys/rates matching a pattern. |
| `npm run presets` | List loopctl's built-in `--preset` prompts. |
| `npm run demo` / `npm run demo:subagent` | Smoke test against an empty / sample payload. |

> `loopctl on` / `off` / `status` are deliberately not npm scripts (npm `run` uses the package dir as cwd, so a `npm run loopctl:on` would toggle the loop for *this repo*, not your project). Run `loopctl on` directly inside the target project.

### Dependencies

None — only Node.js built-ins (`fs`, `path`, `os`, `readline`, `child_process`, `url`, `https`). Node.js ≥ 16.

### How the status line gets its data

Claude Code pipes a JSON payload on stdin. The main-session payload has session/cost/rate-limit info but no per-message token/timing data, so the script re-parses the JSONL transcript at `data.transcript_path` line-by-line, pairing each `assistant` message's `usage.output_tokens` with the timestamp of the preceding `user` message to derive TPS and accumulate session-wide input/output totals (excluding cache-read tokens from the input sum, since those repeat every turn). For subagent rows, the per-task rate comes from `tokenSamples` (parsed defensively; falls back to `tokenCount / elapsed` when the shape is unrecognized).

### Known limitations

- **TPS is not real-time** — the line only re-runs when a new assistant message completes, `/compact` finishes, permission mode changes, etc. For more frequent refresh, add `"refreshInterval": 2` to the `statusLine` config in `~/.claude/settings.json`.
- **TPS reads low** — the denominator is "previous user/tool_result timestamp → assistant message completion", which includes network round-trips and time-to-first-token rather than pure decode time.
- **`~cost:` is an estimate** — see [Cost estimation](#cost-estimation).
- **Subagent `tokenSamples` is undocumented** — falls back to a coarse `tokenCount / elapsed-time` estimate and is labeled `tok/s` rather than `TPS`.
- **Branch links support GitHub / GitLab / Bitbucket only** — self-hosted Git renders the branch as plain text rather than a guessed-wrong link.
- **loopctl is an open-ended autonomous loop** — the round cap only prevents infinite runs; it doesn't check whether the work is actually done. Don't leave it unattended for long stretches.
- **loopctl's `--max` is bounded by Claude Code's own Stop-hook protection** (8 by default).
- **loopctl's `--push` pushes directly to the current branch** (including `main`) — no dedicated-branch guard. Push failures don't abort the loop but are folded into the `reason` text.

### Notes

The end of `statusline.js` contains an optional, environment-specific integration: if `AUTOCLAUDE_BROADCAST` is set to a `broadcast.js` module path, the current session info is broadcast to an "AutoClaude" sensor. Wrapped in try/catch; silently skips when the variable is unset or the path is missing, so it never affects status line output.