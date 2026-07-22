#!/usr/bin/env node
// Claude Code status line: shows model + output tokens/sec (TPS) of the last response,
// plus session cost/usage context. Also doubles as a subagentStatusLine renderer: when
// stdin contains a `tasks` array (the shape Claude Code uses for subagent rows) instead
// of the main session fields, it renders one line per subagent row instead.
// Claude Code pipes session JSON on stdin, but token/timing data for the main status
// line is NOT in that JSON, so we parse the transcript file (transcript_path) to
// compute TPS there. Subagent rows carry their own tokenCount/startTime instead.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { execSync } = require('child_process');
const { pathToFileURL } = require('url');

const ANSI = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
};

function color(text, code) {
  return `${code}${text}${ANSI.reset}`;
}

// Threshold coloring shared by context-window % and rate-limit %.
function colorForPercentage(pct) {
  return pct >= 90 ? ANSI.red : pct >= 70 ? ANSI.yellow : ANSI.green;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatCost(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

// --- Transparent per-model cost estimation ---
// The status line used to display data.cost.total_cost_usd verbatim, but that
// value is Claude Code's client-side estimate priced at Anthropic's rates —
// wrong when you route to a third-party model (e.g. MiniMax via
// ANTHROPIC_BASE_URL). Instead we compute cost ourselves from the token counts
// already parsed from the transcript, using a public, editable pricing table.
//
// The table lives in `pricing.json` next to this script (one file, the single
// source of truth — maintained in the repo, shipped to users). All rates are
// USD per 1,000,000 tokens, shape: { "<model>": { in, out, cacheRead, cacheWrite } }.
// Keys match first by exact name, then by longest case-insensitive substring
// (so "claude-sonnet-5-20250514" matches "claude-sonnet-5"). When no entry
// matches the current model, cost falls back to data.cost.total_cost_usd and is
// labeled "~cost?:" to flag that it's the untrusted client estimate rather than
// a self-computed figure. Refresh the file with `node pricing-updater.js`.

// Load the pricing table from pricing.json next to this script. After
// `--install` that's ~/.claude/pricing.json; run from the repo it's the repo's
// ./pricing.json. Best-effort: missing/invalid file → {} (cost falls back to
// the client estimate). Never writes — pricing-updater.js owns updates.
function loadPricing() {
  try {
    const file = path.join(__dirname, 'pricing.json');
    if (!fs.existsSync(file)) return {};
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

// Resolve a pricing entry for a model name: exact match → longest substring
// match → null (no entry). The longest-match rule prevents a short key from
// shadowing a more specific one when several keys match.
function resolvePricing(model, table) {
  if (!model) return null;
  if (table[model]) return table[model];
  const lower = model.toLowerCase();
  let bestKey = null;
  for (const key of Object.keys(table)) {
    if (lower.includes(key.toLowerCase())) {
      if (!bestKey || key.length > bestKey.length) bestKey = key;
    }
  }
  return bestKey ? table[bestKey] : null;
}

// Compute session cost (USD) from token totals and a pricing entry.
// cacheWrite prices cache_creation_input_tokens; cacheRead prices
// cache_read_input_tokens. Returns null if no pricing entry.
function computeCost(p, freshInput, output, cacheReadTok, cacheCreateTok) {
  if (!p) return null;
  const m = 1e6;
  return (
    (freshInput / m) * p.in +
    (output / m) * p.out +
    (cacheReadTok / m) * p.cacheRead +
    (cacheCreateTok / m) * p.cacheWrite
  );
}

// Compact token counts: 1500 -> "1.5k", 602192 -> "602k", 2_100_000 -> "2.1M".
function formatTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e4) return `${Math.round(v / 1e3)}k`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}

function osc8(text, url) {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function osc8FileLink(text, targetPath) {
  return osc8(text, pathToFileURL(targetPath).href);
}

// Builds a URL to the branch's browse page on the repo's host, from the
// `workspace.repo` fields Claude Code already parses out of the `origin`
// remote (no extra `git remote` call needed). Each host has its own path
// shape for "browse this branch"; unrecognized/self-hosted hosts get no
// link rather than a guessed-wrong one. Returns null for a detached-HEAD
// short hash (getGitBranch's fallback), since that isn't a branch page.
function buildBranchUrl(repo, branch) {
  if (!repo || !repo.host || !repo.owner || !repo.name || !branch) return null;
  if (/^[0-9a-f]{7,40}$/i.test(branch)) return null;

  const branchPath = branch.split('/').map(encodeURIComponent).join('/');
  const { host, owner, name } = repo;
  if (/github/i.test(host)) return `https://${host}/${owner}/${name}/tree/${branchPath}`;
  if (/gitlab/i.test(host)) return `https://${host}/${owner}/${name}/-/tree/${branchPath}`;
  if (/bitbucket/i.test(host)) return `https://${host}/${owner}/${name}/src/${branchPath}`;
  return null;
}

// When --yes is passed alongside --install (used by npm postinstall),
// auto-answer yes to overwrite prompts so the install can run unattended.
// Manual `statusline.js --install` is unchanged — --yes must be explicit.
const AUTO_YES = process.argv.includes('--yes');

function promptYesNo(question) {
  if (AUTO_YES) {
    console.log(`${question} (y/n): y`);
    return Promise.resolve(true);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${question} (y/n): `, answer => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function installStatusLine() {
  const claudeDir = path.join(os.homedir(), '.claude');
  const targetScript = path.join(claudeDir, 'statusline.js');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const sourceContent = fs.readFileSync(__filename, 'utf8');

  fs.mkdirSync(claudeDir, { recursive: true });

  let copyScript = true;
  if (fs.existsSync(targetScript)) {
    const existingContent = fs.readFileSync(targetScript, 'utf8');
    if (existingContent === sourceContent) {
      console.log('statusline.js is already up to date, nothing to install.');
      copyScript = false;
    } else {
      copyScript = await promptYesNo(`Found an existing statusline.js (${targetScript}), update it?`);
      if (!copyScript) console.log('Update cancelled, existing file kept.');
    }
  }

  if (copyScript) {
    fs.writeFileSync(targetScript, sourceContent);
    console.log(`Installed statusline.js to ${targetScript}`);
  }

  // Seed ~/.claude/pricing.json from the bundled pricing.json (sits next to
  // this script) so cost estimation works out of the box. Only seed when the
  // target doesn't exist — never overwrite, since the user may have refreshed
  // their copy with `pricing-updater.js` or hand-edited rates.
  const bundledPricing = path.join(__dirname, 'pricing.json');
  const targetPricing = path.join(claudeDir, 'pricing.json');
  if (bundledPricing !== targetPricing && fs.existsSync(bundledPricing) && !fs.existsSync(targetPricing)) {
    fs.copyFileSync(bundledPricing, targetPricing);
    console.log(`Seeded ${targetPricing} (run 'pricing-updater' anytime to refresh rates)`);
  }

  const commandPath = targetScript.split(path.sep).join('/');
  const desiredCommand = `node "${commandPath}"`;

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      settings = {};
    }
  }

  // The same script auto-detects subagent-row input (a `tasks` array on stdin)
  // vs. the main session input, so both settings can point at one file.
  let changed = false;

  const currentCommand = settings.statusLine && settings.statusLine.command;
  if (currentCommand === desiredCommand) {
    console.log('statusLine config in settings.json is already up to date.');
  } else {
    let writeMain = true;
    if (currentCommand) {
      writeMain = await promptYesNo(
        `settings.json already has a statusLine (${currentCommand}), replace it with ${desiredCommand}?`
      );
    }
    if (writeMain) {
      settings.statusLine = { ...settings.statusLine, type: 'command', command: desiredCommand };
      changed = true;
    } else {
      console.log('Update to statusLine cancelled.');
    }
  }

  const currentSubagentCommand = settings.subagentStatusLine && settings.subagentStatusLine.command;
  if (currentSubagentCommand === desiredCommand) {
    console.log('subagentStatusLine config in settings.json is already up to date.');
  } else {
    let writeSubagent = true;
    if (currentSubagentCommand) {
      writeSubagent = await promptYesNo(
        `settings.json already has a subagentStatusLine (${currentSubagentCommand}), replace it with ${desiredCommand}?`
      );
    }
    if (writeSubagent) {
      settings.subagentStatusLine = { ...settings.subagentStatusLine, type: 'command', command: desiredCommand };
      changed = true;
    } else {
      console.log('Update to subagentStatusLine cancelled.');
    }
  }

  if (changed) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.log(`Updated ${settingsPath}`);
  }
}

if (process.argv.includes('--install')) {
  installStatusLine()
    .catch(err => {
      console.error('Install failed:', err.message);
      process.exitCode = 1;
    });
  return;
}

// Resolve the .git directory by walking up from startDir. Handles the common
// case (a real .git directory) plus the "gitdir: ..." pointer file used by
// worktrees and submodules. Returns an absolute path or null.
function findGitDir(startDir) {
  let dir = startDir;
  for (let i = 0; i < 64 && dir; i++) {
    const candidate = path.join(dir, '.git');
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) return candidate;
      if (stat.isFile()) {
        const content = fs.readFileSync(candidate, 'utf8').trim();
        const m = content.match(/^gitdir:\s*(.+)$/);
        if (m) return path.resolve(dir, m[1].trim());
      }
    } catch {
      /* not here, keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Read the current branch by parsing .git/HEAD directly (~1ms), which is ~90x
// faster than spawning `git`. Falls back to the git CLI only if parsing fails.
function getGitBranch(currentDir) {
  try {
    const gitDir = findGitDir(currentDir);
    if (gitDir) {
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
      if (m) return m[1];
      // Detached HEAD: show short commit hash.
      if (/^[0-9a-f]{7,40}$/i.test(head)) return head.slice(0, 7);
    }
  } catch {
    /* fall through to git CLI */
  }
  try {
    const branch = execSync('git branch --show-current', {
      cwd: currentDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
}

// Read-only view of the auto-loop state written by loopctl.js
// (<currentDir>/.claude/loop-state.json). This never writes to that file —
// toggling the loop is loopctl's job, the status line only displays it.
function readLoopState(currentDir) {
  try {
    const raw = fs.readFileSync(path.join(currentDir, '.claude', 'loop-state.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Accepts an ISO timestamp string, epoch ms, or epoch seconds; returns epoch ms or null.
function parseTimestamp(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// The shape of a subagent's `tokenSamples` entry is not documented, so this
// probes a few plausible shapes (array of numbers, or objects with a
// timestamp-like and a token-count-like field) rather than assuming one.
// Returns tokens/sec between the last two usable samples, or null if the
// samples don't look usable.
function estimateRecentRate(tokenSamples) {
  if (!Array.isArray(tokenSamples) || tokenSamples.length < 2) return null;

  const samples = tokenSamples
    .map(entry => {
      if (entry && typeof entry === 'object') {
        const t = parseTimestamp(entry.timestamp ?? entry.ts ?? entry.time ?? null);
        const tokensRaw = entry.tokens ?? entry.tokenCount ?? entry.count ?? entry.value;
        const tokens = typeof tokensRaw === 'number' ? tokensRaw : null;
        return { t, tokens };
      }
      return { t: null, tokens: null };
    })
    .filter(s => s.t !== null && s.tokens !== null);

  if (samples.length < 2) return null;
  const a = samples[samples.length - 2];
  const b = samples[samples.length - 1];
  const dt = (b.t - a.t) / 1000;
  const dTokens = b.tokens - a.tokens;
  if (dt <= 0 || dTokens < 0) return null;
  return dTokens / dt;
}

// Renders the subagentStatusLine format: one NDJSON line per task,
// {"id": "<task id>", "content": "<row body>"}. tokenCount appears to be a
// running total (context usage), not output-only, so the rate shown here is
// labeled "tok/s" (throughput) rather than "TPS" (generation speed) to avoid
// implying more precision than the documented fields support.
function renderSubagentStatusLine(data) {
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const now = Date.now();
  const lines = [];

  for (const task of tasks) {
    if (!task || !task.id) continue;
    const parts = [color(task.name || task.type || 'agent', ANSI.cyan)];
    if (task.status) parts.push(color(task.status, ANSI.dim));

    let rate = estimateRecentRate(task.tokenSamples);
    if (rate === null && typeof task.tokenCount === 'number' && task.startTime) {
      const startTs = parseTimestamp(task.startTime);
      if (startTs) {
        const elapsedSec = (now - startTs) / 1000;
        if (elapsedSec > 0) rate = task.tokenCount / elapsedSec;
      }
    }
    if (rate !== null) parts.push(color(`${rate.toFixed(1)}tok/s`, ANSI.yellow));

    if (typeof task.tokenCount === 'number') {
      let tokenPart = `tok:${formatTokens(task.tokenCount)}`;
      if (typeof task.contextWindowSize === 'number' && task.contextWindowSize > 0) {
        const pct = Math.round((task.tokenCount / task.contextWindowSize) * 100);
        tokenPart += `(${pct}%)`;
      }
      parts.push(color(tokenPart, ANSI.dim));
    }

    if (task.effort) parts.push(color(`eff:${task.effort}`, ANSI.dim));

    lines.push(JSON.stringify({ id: task.id, content: parts.join(' ') }));
  }

  process.stdout.write(lines.join('\n'));
}

const chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', () => {
  let data = {};
  try {
    data = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    data = {};
  }

  // subagentStatusLine sends { columns, tasks: [...] } instead of the main
  // session fields; the main statusLine input never has a `tasks` array.
  if (Array.isArray(data.tasks)) {
    renderSubagentStatusLine(data);
    return;
  }

  const model =
    (data.model && data.model.display_name) ||
    process.env.ANTHROPIC_MODEL ||
    'model';

  const currentDir =
    (data.workspace && data.workspace.current_dir) ||
    data.cwd ||
    process.cwd();
  const directoryName = path.basename(currentDir) || currentDir;
  const directoryLink = osc8FileLink(`📁 ${directoryName}`, currentDir);
  const gitBranch = getGitBranch(currentDir);
  const branchUrl = buildBranchUrl(data.workspace && data.workspace.repo, gitBranch);

  let tps = null;
  let outputTokens = null;
  let cacheRead = null;       // cache_read_input_tokens of the last response
  let sessionInput = 0;       // session-wide input tokens (incl. cache) — for Σ↓ display
  let sessionOutput = 0;      // session-wide output tokens
  // Split totals for transparent cost pricing (see computeCost):
  let sessionFreshInput = 0;  // input_tokens, billed at p.in
  let sessionCacheCreate = 0; // cache_creation_input_tokens, billed at p.cacheWrite
  let sessionCacheRead = 0;    // cache_read_input_tokens (session total), billed at p.cacheRead
  let sawUsage = false;

  try {
    const tp = data.transcript_path;
    if (tp && fs.existsSync(tp)) {
      const lines = fs.readFileSync(tp, 'utf8').split('\n').filter(Boolean);

      let lastUserTs = null;      // start time of the current request (user msg / tool result)
      let lastAssistant = null;   // { outputTokens, ts, startTs, usage }

      for (const line of lines) {
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const ts = obj.timestamp ? Date.parse(obj.timestamp) : null;

        if (
          obj.type === 'assistant' &&
          obj.message &&
          obj.message.usage &&
          typeof obj.message.usage.output_tokens === 'number'
        ) {
          const usage = obj.message.usage;
          lastAssistant = {
            outputTokens: usage.output_tokens,
            ts,
            startTs: lastUserTs,
            usage,
          };
          // Accumulate session totals across every assistant turn. Count only
          // newly-processed input (fresh tokens + cache writes); cache reads are
          // repeated every turn and would inflate the total meaninglessly.
          sawUsage = true;
          sessionOutput += usage.output_tokens || 0;
          sessionInput +=
            (usage.input_tokens || 0) +
            (usage.cache_creation_input_tokens || 0);
          // Split accumulators for cost pricing (cache reads are billed
          // separately here, unlike the Σ↓ display total which excludes them).
          sessionFreshInput += usage.input_tokens || 0;
          sessionCacheCreate += usage.cache_creation_input_tokens || 0;
          sessionCacheRead += usage.cache_read_input_tokens || 0;
        } else if (obj.type === 'user') {
          // user prompt or tool_result marks the start of the next generation
          lastUserTs = ts;
        }
      }

      if (lastAssistant) {
        outputTokens = lastAssistant.outputTokens;
        if (typeof lastAssistant.usage.cache_read_input_tokens === 'number') {
          cacheRead = lastAssistant.usage.cache_read_input_tokens;
        }
        if (
          lastAssistant.ts &&
          lastAssistant.startTs &&
          lastAssistant.ts > lastAssistant.startTs
        ) {
          const sec = (lastAssistant.ts - lastAssistant.startTs) / 1000;
          if (sec > 0) tps = (lastAssistant.outputTokens / sec).toFixed(1);
        }
      }
    }
  } catch {
    /* ignore, fall through to whatever we have */
  }

  // Cost: prefer a transparent self-computed figure from transcript token
  // counts + the public pricing.json table (labeled "~cost:"). Fall back to the
  // client estimate in data.cost.total_cost_usd (labeled "~cost?:") when we
  // have no token data or no pricing entry for the current model. Both are
  // estimates — hence the "~" prefix — but the self-computed one is priced at
  // the rates you control in pricing.json, so it matches what you actually pay
  // when routed to a third-party model.
  const pricing = resolvePricing(model, loadPricing());
  const selfCost = sawUsage && pricing
    ? computeCost(pricing, sessionFreshInput, sessionOutput, sessionCacheRead, sessionCacheCreate)
    : null;
  const clientCost = data.cost && typeof data.cost.total_cost_usd === 'number'
    ? data.cost.total_cost_usd
    : null;
  const durationMs = data.cost && typeof data.cost.total_duration_ms === 'number'
    ? data.cost.total_duration_ms
    : null;
  const linesAdded = data.cost && typeof data.cost.total_lines_added === 'number'
    ? data.cost.total_lines_added
    : null;
  const linesRemoved = data.cost && typeof data.cost.total_lines_removed === 'number'
    ? data.cost.total_lines_removed
    : null;

  // First line: identity + workspace + context usage.
  const cw = data.context_window;
  const firstLineParts = [color(`[${model}]`, ANSI.cyan), directoryLink];
  if (gitBranch) {
    const branchLabel = branchUrl ? osc8(`🌿 ${gitBranch}`, branchUrl) : `🌿 ${gitBranch}`;
    firstLineParts.push(color(branchLabel, ANSI.green));
  }

  if (data.pr && typeof data.pr.number === 'number') {
    const reviewIcon = { approved: '✅', pending: '👀', changes_requested: '❗', draft: '📝' }[data.pr.review_state] || '';
    firstLineParts.push(color(`PR#${data.pr.number}${reviewIcon}`, ANSI.dim));
  }

  if (data.session_name) firstLineParts.push(color(`"${data.session_name}"`, ANSI.dim));

  const loopState = readLoopState(currentDir);
  if (loopState && loopState.enabled) {
    firstLineParts.push(color(`🔁loop:${loopState.currentRound}/${loopState.maxRounds}`, ANSI.yellow));
  }

  if (cw && typeof cw.used_percentage === 'number') {
    const pct = Math.round(cw.used_percentage);
    firstLineParts.push(color(`ctx:${pct}%`, colorForPercentage(pct)));
  }

  // Second line: live activity + cost + mode flags. Grouped left-to-right as
  // speed → last response → cache → session totals → lines changed → cost →
  // duration → rate limits → mode flags (fast/thinking/effort/vim).
  const secondLineParts = [];
  if (tps !== null) secondLineParts.push(color(`TPS:${tps}`, ANSI.yellow));
  if (outputTokens !== null) secondLineParts.push(color(`out:${formatTokens(outputTokens)}`, ANSI.dim));
  if (cacheRead !== null && cacheRead > 0) {
    secondLineParts.push(color(`cache:${formatTokens(cacheRead)}`, ANSI.green));
  }
  if (sawUsage && (sessionInput > 0 || sessionOutput > 0)) {
    secondLineParts.push(color(`Σ↓${formatTokens(sessionInput)} ↑${formatTokens(sessionOutput)}`, ANSI.cyan));
  }
  if (linesAdded !== null || linesRemoved !== null) {
    secondLineParts.push(
      `${color(`+${linesAdded || 0}`, ANSI.green)}${color(`/-${linesRemoved || 0}`, ANSI.red)}`
    );
  }
  if (selfCost !== null) {
    secondLineParts.push(color(`~cost:${formatCost(selfCost)}`, ANSI.yellow));
  } else if (clientCost !== null) {
    secondLineParts.push(color(`~cost?:${formatCost(clientCost)}`, ANSI.yellow));
  }
  if (durationMs !== null) secondLineParts.push(color(`dur:${formatDuration(durationMs)}`, ANSI.dim));

  // Rate limits + mode flags append to the end of the second line, only when present.
  const fiveHourPct = data.rate_limits && data.rate_limits.five_hour && typeof data.rate_limits.five_hour.used_percentage === 'number'
    ? Math.round(data.rate_limits.five_hour.used_percentage)
    : null;
  const sevenDayPct = data.rate_limits && data.rate_limits.seven_day && typeof data.rate_limits.seven_day.used_percentage === 'number'
    ? Math.round(data.rate_limits.seven_day.used_percentage)
    : null;
  if (fiveHourPct !== null) secondLineParts.push(color(`5h:${fiveHourPct}%`, colorForPercentage(fiveHourPct)));
  if (sevenDayPct !== null) secondLineParts.push(color(`7d:${sevenDayPct}%`, colorForPercentage(sevenDayPct)));

  if (data.fast_mode) secondLineParts.push(color('⚡fast', ANSI.yellow));
  if (data.thinking && data.thinking.enabled) secondLineParts.push(color('🧠think', ANSI.dim));
  if (data.effort && data.effort.level) secondLineParts.push(color(`eff:${data.effort.level}`, ANSI.dim));
  if (data.vim && data.vim.mode) secondLineParts.push(color(`VIM:${data.vim.mode}`, ANSI.dim));

  const lines = [firstLineParts.join(' ')];
  if (secondLineParts.length) lines.push(secondLineParts.join(' '));

  process.stdout.write(lines.join('\n'));

  // --- AutoClaude sensor broadcast (best-effort, never blocks) ---
  // Opt-in: set AUTOCLAUDE_BROADCAST to the path of broadcast.js. No-op when
  // unset or the path is missing — never breaks the status line.
  try {
    const broadcastPath = process.env.AUTOCLAUDE_BROADCAST;
    if (!broadcastPath) return;
    const { buildFrame, sendFrame } = require(broadcastPath);
    const tpath = data.transcript_path || '';
    const sid = data.session_id
      || (tpath ? path.basename(tpath, '.jsonl') : '')
      || '';
    sendFrame(buildFrame({ sessionId: sid, cwd: currentDir, transcriptPath: tpath }));
  } catch { /* ignore */ }
});
