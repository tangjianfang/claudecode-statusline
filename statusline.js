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

// Same as formatDuration but without the space, for tight inline layouts
// (subagent rows). "1m23s" instead of "1m 23s" — the space would split
// visually when joined with the rest of the row tokens.
function formatDurationCompact(ms) {
  const totalSeconds = Math.max(0, Math.floor((ms || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  const remMins = minutes % 60;
  return `${hours}h${remMins}m`;
}

// Compact window/token-size label without the "1.0" padding of formatTokens:
// 1,000,000 -> "1M", 200000 -> "200k". Used for the context-window total.
function fmtCompact(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${parseFloat((v / 1e6).toFixed(1))}M`;
  if (v >= 1e3) return `${parseFloat((v / 1e3).toFixed(1))}k`;
  return String(v);
}

// Compact "time until reset" label for rate-limit windows, e.g. " (2h06m)".
// Returns '' when resets_at is absent, unparseable, in the past, or >48h out
// (a reset that far away is not actionable and would only add clutter).
function formatUntil(resetsAt) {
  const ts = parseTimestamp(resetsAt);
  if (!ts) return '';
  const delta = ts - Date.now();
  if (delta <= 0 || delta > 48 * 3600 * 1000) return '';
  return ` (${formatDurationCompact(delta)})`;
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

// Resolve the interpreter to register in settings.json. Normally the current
// Node binary (process.execPath), EXCEPT under Bun: when Bun runs lifecycle
// scripts (postinstall) it spawns a `node` compatibility shim in the OS temp
// dir (...\Temp\bun-node-<hash>\node.exe), and process.execPath points at
// that throwaway copy — registering it would break the status line the next
// time the temp dir is cleaned. process.versions.bun is set in both real-bun
// and shim mode (the Bun global object only exists in real-bun mode), so
// detect Bun there and locate the real binary: Bun.execPath → BUN_INSTALL →
// a PATH scan. Falls back to a bare "bun" rather than the temp shim.
function resolveInterpreter() {
  if (!process.versions.bun) return process.execPath;
  try {
    if (typeof Bun !== 'undefined' && Bun.execPath) return Bun.execPath;
  } catch { /* shim mode has no Bun global */ }
  const name = process.platform === 'win32' ? 'bun.exe' : 'bun';
  if (process.env.BUN_INSTALL) {
    const cand = path.join(process.env.BUN_INSTALL, 'bin', name);
    if (fs.existsSync(cand)) return cand;
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    // Skip Bun's temp script-shim dir (...\Temp\bun-node-<hash>\): it hosts
    // node.exe/bun.exe copies that vanish when the OS cleans the temp dir.
    if (!dir || dir.includes('bun-node-')) continue;
    const cand = path.join(dir, name);
    try {
      if (fs.statSync(cand).isFile() && fs.statSync(cand).size > 0) return cand;
    } catch { /* keep scanning */ }
  }
  return 'bun';
}

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
  // Use the absolute path of the running interpreter, not a bare "node":
  // Claude Code spawns statusLine commands via a non-interactive shell that
  // may not have node on PATH (nvm/volta on macOS/Linux install node outside
  // the system PATH), which would silently break the status line there.
  // Under Bun this resolves to the real bun binary (see resolveInterpreter).
  const desiredCommand = `"${resolveInterpreter()}" "${commandPath}"`;

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

// Diagnostic: report the current install state of the status line + pricing.json.
// Mirrors `status`-style commands so users have one place to check whether
// `npm install -g` actually wired everything up — useful when the postinstall
// silently fails (read-only ~/.claude, locked settings.json, etc.).
function cmdStatus() {
  const home = os.homedir();
  const claudeDir = path.join(home, '.claude');
  const slPath = path.join(claudeDir, 'statusline.js');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const pricingPath = path.join(claudeDir, 'pricing.json');

  const exists = p => {
    try { return fs.statSync(p); } catch { return null; }
  };

  const fileLine = (label, p) => {
    const st = exists(p);
    if (!st) return `  ${label.padEnd(28)} NOT FOUND (${p})`;
    const mtime = st.mtime.toISOString().replace('T', ' ').slice(0, 19);
    return `  ${label.padEnd(28)} ${st.size}B  mtime=${mtime}`;
  };

  console.log('cc-statusline install state:');
  console.log(fileLine('~/.claude/statusline.js', slPath));
  console.log(fileLine('~/.claude/settings.json',  settingsPath));
  console.log(fileLine('~/.claude/pricing.json',   pricingPath));

  // settings.json content checks
  let settings = null;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    console.log('\n  settings.json: COULD NOT PARSE');
  }
  if (settings) {
    const sl = settings.statusLine && settings.statusLine.command;
    const sub = settings.subagentStatusLine && settings.subagentStatusLine.command;
    console.log('\n  settings.json contents:');
    console.log(`    statusLine:           ${sl ? 'registered → ' + sl : 'NOT REGISTERED'}`);
    console.log(`    subagentStatusLine:   ${sub ? 'registered → ' + sub : 'NOT REGISTERED'}`);
  }

  // pricing.json entry count
  const pricing = exists(pricingPath);
  if (pricing) {
    try {
      const p = JSON.parse(fs.readFileSync(pricingPath, 'utf8'));
      console.log(`\n  pricing.json: ${Object.keys(p).length} entries`);
    } catch {
      console.log('\n  pricing.json: COULD NOT PARSE');
    }
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

if (process.argv[2] === 'status') {
  cmdStatus();
  return;
}

// --help / -H / help: print the full command reference. Also auto-show when
// the user invokes `cc-statusline` directly in a terminal (stdin is a TTY)
// without piping anything — Claude Code always pipes a payload, so this
// branch is only hit when a human is poking at the bin interactively.
function printStatuslineHelp() {
  console.log(`cc-statusline — Claude Code status line
https://github.com/tangjianfang/claudecode-statusline

This tool is normally called BY Claude Code (it pipes a JSON payload to
stdin and renders the status line). You don't usually invoke it directly
unless you're checking the install or debugging.

USAGE (called by Claude Code automatically):
  echo '{...payload...}' | cc-statusline     # renders the status line

HUMAN COMMANDS:
  cc-statusline --install        install as your statusLine + subagentStatusLine (~/.claude/)
  cc-statusline status           show what's currently wired (files, settings.json, pricing.json)
  cc-statusline --help | -H      show this help

DOCS:  https://github.com/tangjianfang/claudecode-statusline#readme`);
}

if (
  process.argv.includes('--help') ||
  process.argv.includes('-H') ||
  process.argv[2] === 'help' ||
  (process.argv.length <= 2 && process.stdin.isTTY === true)
) {
  printStatuslineHelp();
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

// Per-agent real stats from the agent's own transcript. Claude Code stores
// background/local agents at <project dir>/<session id>/subagents/agent-<task
// id>.jsonl — a subdirectory named after the session id, next to the session
// transcript — with the same assistant/user entry shape (usage + timestamps)
// as the main transcript, so the same TPS pairing and total accumulation
// apply. This exists because the payload's own tokenCount/tokenSamples stay 0
// for whole runs on current builds (verified by payload capture). Returns
// null when there is no such file (older builds / other task kinds).
function agentTranscriptStats(data, task) {
  try {
    if (!data.transcript_path || !task.id) return null;
    const sid = data.session_id || path.basename(data.transcript_path, '.jsonl');
    const file = path.join(path.dirname(data.transcript_path), sid, 'subagents', `agent-${task.id}.jsonl`);
    if (!fs.existsSync(file)) return null;
    // Cap at the last 10MB of very long runs — plenty of history for accurate
    // totals, immune to pathological file growth.
    const SIZE_CAP = 10 * 1024 * 1024;
    const st = fs.statSync(file);
    let text;
    if (st.size > SIZE_CAP) {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(SIZE_CAP);
      fs.readSync(fd, buf, 0, SIZE_CAP, st.size - SIZE_CAP);
      fs.closeSync(fd);
      text = buf.toString('utf8').slice(buf.toString('utf8').indexOf('\n') + 1);
    } else {
      text = fs.readFileSync(file, 'utf8');
    }
    let lastUserTs = null;
    let last = null;
    let totOut = 0, totIn = 0, totCacheRead = 0, totCacheCreate = 0;
    const seen = new Set();
    for (const line of text.split('\n')) {
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const ts = obj.timestamp ? Date.parse(obj.timestamp) : null;
      if (obj.type === 'user' && ts) lastUserTs = ts;
      if (obj.type === 'assistant' && obj.message && obj.message.usage &&
          typeof obj.message.usage.output_tokens === 'number') {
        const u = obj.message.usage;
        last = {
          ts,
          out: u.output_tokens || 0,
          spanS: lastUserTs && ts && ts > lastUserTs ? (ts - lastUserTs) / 1000 : null,
          in: u.input_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          cacheCreate: u.cache_creation_input_tokens || 0,
        };
        if (obj.message.id && !seen.has(obj.message.id)) {
          seen.add(obj.message.id);
          totOut += u.output_tokens || 0;
          totIn += u.input_tokens || 0;
          totCacheRead += u.cache_read_input_tokens || 0;
          totCacheCreate += u.cache_creation_input_tokens || 0;
        }
      }
    }
    if (!last) return null;
    return {
      ctxTokens: last.in + last.cacheRead + last.cacheCreate,
      lastTps: last.spanS && last.spanS > 0.3 ? last.out / last.spanS : null,
      totOut, totIn, totCacheRead, totCacheCreate,
    };
  } catch {
    return null;
  }
}

// Renders the subagentStatusLine format: one NDJSON line per task,
// {"id": "<task id>", "content": "<row body>"}. Real per-agent stats come
// from the agent transcript (see agentTranscriptStats) when available;
// otherwise the payload's own tokenCount/tokenSamples are used (labeled
// "tok/s" — a coarser throughput figure — rather than transcript-derived
// "TPS").
function renderSubagentStatusLine(data) {
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const now = Date.now();
  const lines = [];

  const pricing = loadPricing();

  for (const task of tasks) {
    if (!task || !task.id) continue;
    const parts = [color(task.name || task.type || 'agent', ANSI.cyan)];
    if (task.status) parts.push(color(task.status, ANSI.dim));

    // Live activity label — updates every refresh tick, and on builds where
    // tokenCount stays 0 it is the strongest "is it alive" signal.
    const activity = task.label || task.description || '';
    if (activity) {
      const shown = activity.length > 48 ? activity.slice(0, 47) + '…' : activity;
      parts.push(color(shown, ANSI.dim));
    }

    // Elapsed time from startTime — reused for both the rate fallback and
    // the visible duration field.
    let elapsedSec = null;
    if (task.startTime) {
      const startTs = parseTimestamp(task.startTime);
      if (startTs) elapsedSec = (now - startTs) / 1000;
    }

    const stats = agentTranscriptStats(data, task);

    let rate = null;
    if (stats && stats.lastTps !== null && stats.lastTps > 0 && stats.lastTps < 5000) {
      rate = stats.lastTps;
    } else {
      rate = estimateRecentRate(task.tokenSamples);
      if (rate === null && typeof task.tokenCount === 'number' && elapsedSec !== null && elapsedSec > 0) {
        rate = task.tokenCount / elapsedSec;
      }
      // Hide zero/absurd rates instead of showing "0.0tok/s": a zero here
      // means "no tokens reported" (tokenCount is populated sparsely), an
      // absurd value means tokenSamples didn't parse into a sane shape.
      if (rate !== null && (rate <= 0 || rate >= 10000)) rate = null;
    }
    if (rate !== null) {
      parts.push(color(`${rate.toFixed(1)}${stats ? 'TPS' : 'tok/s'}`, ANSI.yellow));
    }

    // Token count: prefer the transcript-derived live context size; fall
    // back to the payload's tokenCount when positive. Zero stays hidden —
    // "tok:0(0%)" for a whole run reads as a frozen display, not missing data.
    const tokCount = stats
      ? stats.ctxTokens
      : typeof task.tokenCount === 'number' && task.tokenCount > 0
        ? task.tokenCount
        : null;
    if (tokCount !== null && tokCount > 0) {
      let tokenPart = `tok:${formatTokens(tokCount)}`;
      if (typeof task.contextWindowSize === 'number' && task.contextWindowSize > 0) {
        tokenPart += `(${Math.round((tokCount / task.contextWindowSize) * 100)}%)`;
      }
      parts.push(color(tokenPart, ANSI.dim));
    }
    if (stats) parts.push(color(`out:${formatTokens(stats.totOut)}`, ANSI.dim));

    // Duration: helps catch stuck subagents (e.g. 30m on one row).
    if (elapsedSec !== null && elapsedSec >= 1) {
      parts.push(color(formatDurationCompact(elapsedSec * 1000), ANSI.dim));
    }

    // Cost: from the agent transcript's token split when available (same
    // formula as the main line); otherwise the coarse tokenCount × input-rate
    // approximation. The task's own model is preferred; ANTHROPIC_MODEL is
    // the fallback for payloads without per-task model info.
    const pricingEntry = (task.model && resolvePricing(task.model, pricing)) ||
      (process.env.ANTHROPIC_MODEL ? resolvePricing(process.env.ANTHROPIC_MODEL, pricing) : null);
    if (pricingEntry) {
      let cost = null;
      if (stats) {
        cost = computeCost(pricingEntry, stats.totIn, stats.totOut, stats.totCacheRead, stats.totCacheCreate);
      } else if (typeof task.tokenCount === 'number' && task.tokenCount > 0 && pricingEntry.in > 0) {
        cost = (task.tokenCount / 1e6) * pricingEntry.in;
      }
      if (cost !== null && cost >= 0.0001) parts.push(color(`~$${cost.toFixed(2)}`, ANSI.green));
    }

    if (task.effort) parts.push(color(`eff:${task.effort}`, ANSI.dim));

    lines.push(JSON.stringify({ id: task.id, content: parts.join(' ') }));
  }

  process.stdout.write(lines.join('\n'));
}

const chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks).toString();
  let data = {};
  try {
    data = JSON.parse(raw || '{}');
  } catch {
    data = {};
  }

  // Opt-in payload capture: when ~/.claude/statusline-debug exists, every
  // render appends its raw stdin payload to ~/.claude/statusline-payloads.log
  // (size-capped at ~512KB, oldest lines trimmed). The subagent payload's
  // tokenCount/tokenSamples shapes are undocumented upstream, so this is the
  // way to see real data when a row misbehaves. Delete the flag file to stop.
  try {
    const flag = path.join(os.homedir(), '.claude', 'statusline-debug');
    if (fs.existsSync(flag)) {
      const log = path.join(os.homedir(), '.claude', 'statusline-payloads.log');
      const CAP = 512 * 1024;
      let prev = '';
      try {
        prev = fs.readFileSync(log, 'utf8');
        while (prev.length > CAP / 2 && prev.indexOf('\n') !== -1) {
          prev = prev.slice(prev.indexOf('\n') + 1);
        }
      } catch {
        /* first write */
      }
      const entry = { t: new Date().toISOString(), parseError: data && Object.keys(data).length === 0, payload: data, raw };
      fs.writeFileSync(log, prev + JSON.stringify(entry) + '\n');
    }
  } catch {
    /* logging must never break rendering */
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
  let lastAssistantAgeMs = null; // age of the data behind TPS/out — stale while the main line waits
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
          // Subagent (sidechain) messages ride in the same transcript file
          // but are a different conversation: they belong on their own
          // subagent rows, not on the main line. Keep them out of TPS /
          // out / cache (which describe the main conversation) while still
          // counting them in the session-wide Σ totals below.
          if (obj.isSidechain !== true) {
            lastAssistant = {
              outputTokens: usage.output_tokens,
              ts,
              startTs: lastUserTs,
              usage,
            };
          }
          // Accumulate session totals across every assistant turn (main AND
          // sidechain — Σ is the whole session's spend). Count only
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
          // user prompt or tool_result marks the start of the next generation.
          // Sidechain user entries must not reset the main line's start time.
          if (obj.isSidechain !== true) lastUserTs = ts;
        }
      }

      if (lastAssistant) {
        outputTokens = lastAssistant.outputTokens;
        if (lastAssistant.ts) lastAssistantAgeMs = Date.now() - lastAssistant.ts;
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
    const prKind = data.pr.kind === 'mr' ? 'MR' : 'PR';
    firstLineParts.push(color(`${prKind}#${data.pr.number}${reviewIcon}`, ANSI.dim));
  }

  if (data.session_name) firstLineParts.push(color(`"${data.session_name}"`, ANSI.dim));

  // Worktree sessions (v2.1.x): show which worktree you're in — the branch
  // alone doesn't tell you, since every worktree has its own branch.
  if (data.worktree && data.worktree.name) {
    firstLineParts.push(color(`🌳wt:${data.worktree.name}`, ANSI.dim));
  }

  // Agent sessions (--agent or agent settings): show the active agent.
  if (data.agent && data.agent.name) {
    firstLineParts.push(color(`🤖${data.agent.name}`, ANSI.dim));
  }

  if (cw && typeof cw.used_percentage === 'number') {
    const pct = Math.round(cw.used_percentage);
    let ctxPart = `ctx:${pct}%`;
    // Total window size matters now that 1M-context sessions are common:
    // "ctx:23%/1M" reads very differently from "ctx:23%/200k".
    if (typeof cw.context_window_size === 'number' && cw.context_window_size > 0) {
      ctxPart += `/${fmtCompact(cw.context_window_size)}`;
    }
    firstLineParts.push(color(ctxPart, colorForPercentage(pct)));
  }

  // Second line: live activity + cost + mode flags. Grouped left-to-right as
  // speed → last response → cache → session totals → lines changed → cost →
  // duration → rate limits → mode flags (fast/thinking/effort/vim).
  const secondLineParts = [];
  if (tps !== null) {
    // While the main conversation is idle (e.g. blocked waiting on subagents),
    // this figure is stale by design — it describes the LAST main response,
    // which does not change until the main conversation continues. Mark its
    // age once it's over 2 minutes old so "frozen" reads as "waiting on old
    // data" rather than a broken display.
    const ageLabel =
      lastAssistantAgeMs !== null && lastAssistantAgeMs > 120000
        ? ` (${formatDurationCompact(lastAssistantAgeMs)} ago)`
        : '';
    secondLineParts.push(color(`TPS:${tps}${ageLabel}`, ANSI.yellow));
  }
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

  // Prompt-cache health (v2.1.251+): hit ratio + TTL is the fastest way to see
  // whether your context churn is forcing full cache rebuilds — every rebuild
  // re-bills cache_write on the whole prefix. hit_ratio arrives as a fraction
  // (0..1) on current builds; guard against a 0..100 scale just in case.
  const pc = data.prompt_cache;
  if (pc && pc.caching_observed && typeof pc.hit_ratio === 'number') {
    const pct = Math.round(pc.hit_ratio <= 1 ? pc.hit_ratio * 100 : pc.hit_ratio);
    const ttlLabel = pc.warm && pc.ttl ? `(${pc.ttl})` : '(cold)';
    secondLineParts.push(
      color(`pc:${pct}%${ttlLabel}`, pct >= 80 ? ANSI.green : pct >= 50 ? ANSI.yellow : ANSI.red)
    );
  }

  // Rate limits + mode flags append to the end of the second line, only when present.
  const fiveHour = data.rate_limits && data.rate_limits.five_hour;
  const sevenDay = data.rate_limits && data.rate_limits.seven_day;
  const spendLimit = data.rate_limits && data.rate_limits.spend_limit;
  const fiveHourPct = fiveHour && typeof fiveHour.used_percentage === 'number'
    ? Math.round(fiveHour.used_percentage)
    : null;
  const sevenDayPct = sevenDay && typeof sevenDay.used_percentage === 'number'
    ? Math.round(sevenDay.used_percentage)
    : null;
  if (fiveHourPct !== null) {
    secondLineParts.push(color(`5h:${fiveHourPct}%${formatUntil(fiveHour.resets_at)}`, colorForPercentage(fiveHourPct)));
  }
  if (sevenDayPct !== null) {
    secondLineParts.push(color(`7d:${sevenDayPct}%${formatUntil(sevenDay.resets_at)}`, colorForPercentage(sevenDayPct)));
  }
  if (spendLimit && typeof spendLimit.used_percentage === 'number') {
    const spendPct = Math.round(spendLimit.used_percentage);
    secondLineParts.push(color(`sp:${spendPct}%`, colorForPercentage(spendPct)));
  }

  if (data.fast_mode) secondLineParts.push(color('⚡fast', ANSI.yellow));
  if (data.thinking && data.thinking.enabled) secondLineParts.push(color('🧠think', ANSI.dim));
  if (data.effort && data.effort.level) secondLineParts.push(color(`eff:${data.effort.level}`, ANSI.dim));
  if (data.vim && data.vim.mode) secondLineParts.push(color(`VIM:${data.vim.mode}`, ANSI.dim));
  if (data.output_style && data.output_style.name && !/^default$/i.test(data.output_style.name)) {
    secondLineParts.push(color(`style:${data.output_style.name}`, ANSI.dim));
  }
  if (data.version) secondLineParts.push(color(`v${data.version}`, ANSI.dim));

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
