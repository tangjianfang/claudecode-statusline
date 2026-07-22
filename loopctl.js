#!/usr/bin/env node
// Turns Claude Code's Stop hook into an opt-in auto-continue loop: while enabled,
// every time Claude is about to stop, this script blocks the stop and feeds back a
// "what's next?" prompt instead, up to a configured number of rounds. State lives
// per-project in <project>/.claude/loop-state.json so it's off by default everywhere
// and has to be turned on explicitly in each project you want it in.
//
// Modes (process.argv):
//   --install         copy this file to ~/.claude/loopctl.js and register it as a Stop hook
//   --hook            read Claude Code's Stop-hook JSON from stdin, decide whether to continue
//   on [flags]        enable the loop for the current project (cwd); prompt via --preset <name> or --prompt "text"
//   off               disable the loop for the current project
//   status            print the current loop state for the current project
//   presets           list the built-in --preset prompt templates

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawnSync } = require('child_process');

const STATE_FILE_REL = path.join('.claude', 'loop-state.json');
const DEFAULT_MAX_ROUNDS = 8; // matches Claude Code's built-in Stop-hook block cap
const DEFAULT_PRESET = 'next-step';

// Built-in prompt templates for common "keep going" goals, selectable via
// `--preset <name>` instead of typing out a full --prompt each time. Keys are
// also valid values for `loopctl presets`. Add new goals here rather than
// telling users to memorize long --prompt strings.
const PRESETS = {
  'next-step': 'What is the next task? Plan and execute it.',
  'find-bugs': 'Proactively check the current code for potential bugs or logic issues. Fix any you find and explain the fix.',
  'improve': 'Proactively look for things in the project that can be improved (code quality, readability, performance, docs, test coverage, etc.). Pick one valuable improvement and make it.',
  'tests': 'Check whether the project\'s tests are complete and passing. Add missing test cases or fix failing tests.',
  'docs': 'Check whether the docs (README, comments, etc.) are consistent with the current code. Update anything outdated or missing.',
  'refactor': 'Find a piece of code that can be safely simplified or refactored, and do so without changing behavior.',
};

function resolvePreset(name) {
  if (!(name in PRESETS)) {
    throw new Error(`Unknown preset "${name}". Run "loopctl presets" to see available options.`);
  }
  return PRESETS[name];
}

const DEFAULT_PROMPT = PRESETS[DEFAULT_PRESET];

function defaultState() {
  return {
    enabled: false,
    maxRounds: DEFAULT_MAX_ROUNDS,
    currentRound: 0,
    push: false,
    prompt: DEFAULT_PROMPT,
  };
}

function stateFilePath(dir) {
  return path.join(dir, STATE_FILE_REL);
}

function readState(dir) {
  try {
    const raw = fs.readFileSync(stateFilePath(dir), 'utf8');
    return { ...defaultState(), ...JSON.parse(raw) };
  } catch {
    return null;
  }
}

function writeState(dir, state) {
  const file = stateFilePath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

// When --yes is passed alongside --install (used by npm postinstall),
// auto-answer yes to overwrite prompts so the install can run unattended.
// Manual `loopctl.js --install` is unchanged — --yes must be explicit.
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

// Best-effort `git add -A && git commit && git push` in dir. Uses spawnSync with an
// argv array (not a shell string) so the commit message never needs manual quoting.
// No-ops cleanly when there's nothing to commit or the dir isn't a git repo.
function autoCommitAndPush(dir, round, maxRounds) {
  const run = (cmd, args) => spawnSync(cmd, args, { cwd: dir, encoding: 'utf8' });

  const status = run('git', ['status', '--porcelain']);
  if (status.status !== 0) return { ok: false, reason: 'not a git repository' };
  if (!status.stdout.trim()) return { ok: true, committed: false };

  const add = run('git', ['add', '-A']);
  if (add.status !== 0) return { ok: false, reason: `git add failed: ${add.stderr.trim()}` };

  const commit = run('git', ['commit', '-m', `auto-loop: round ${round}/${maxRounds}`]);
  if (commit.status !== 0) return { ok: false, reason: `git commit failed: ${commit.stderr.trim()}` };

  const push = run('git', ['push']);
  if (push.status !== 0) return { ok: false, reason: `git push failed: ${push.stderr.trim()}` };

  return { ok: true, committed: true };
}

// --preset and --prompt both set overrides.prompt; whichever is parsed later
// wins, so passing both lets --prompt override a preset used as a starting
// point (e.g. `--preset improve --prompt "..."` for a one-off tweak).
function parseOnArgs(args) {
  const overrides = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--max') {
      overrides.maxRounds = parseInt(args[++i], 10);
    } else if (arg === '--push') {
      overrides.push = true;
    } else if (arg === '--no-push') {
      overrides.push = false;
    } else if (arg === '--prompt') {
      overrides.prompt = args[++i];
    } else if (arg === '--preset') {
      overrides.prompt = resolvePreset(args[++i]);
    }
  }
  return overrides;
}

function cmdPresets() {
  console.log('Available --preset values:');
  for (const [name, text] of Object.entries(PRESETS)) {
    console.log(`  ${name}${name === DEFAULT_PRESET ? ' (default)' : ''}\n    ${text}`);
  }
}

function cmdOn(dir, args) {
  let overrides;
  try {
    overrides = parseOnArgs(args);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  const state = { ...(readState(dir) || defaultState()), ...overrides };
  state.enabled = true;
  state.currentRound = 0;

  if (!Number.isFinite(state.maxRounds) || state.maxRounds <= 0) {
    console.error('--max must be a positive integer.');
    process.exitCode = 1;
    return;
  }

  writeState(dir, state);
  console.log(`Auto-loop enabled for ${dir}`);
  console.log(`  maxRounds: ${state.maxRounds}${state.maxRounds > DEFAULT_MAX_ROUNDS
    ? ` (Claude Code's own Stop-hook block cap is ${DEFAULT_MAX_ROUNDS} by default; raise CLAUDE_CODE_STOP_HOOK_BLOCK_CAP or the loop will be force-stopped early)`
    : ''}`);
  console.log(`  push: ${state.push}`);
  console.log(`  prompt: ${state.prompt}`);
}

function cmdOff(dir) {
  const state = { ...(readState(dir) || defaultState()) };
  state.enabled = false;
  state.currentRound = 0;
  writeState(dir, state);
  console.log(`Auto-loop disabled for ${dir}`);
}

function cmdStatus(dir) {
  const state = readState(dir);
  if (!state) {
    console.log(`No loop state for ${dir} (never ran "loopctl on" here).`);
    return;
  }
  console.log(`Loop state for ${dir}:`);
  console.log(`  enabled: ${state.enabled}`);
  console.log(`  round: ${state.currentRound}/${state.maxRounds}`);
  console.log(`  push: ${state.push}`);
  console.log(`  prompt: ${state.prompt}`);
}

// Stop-hook entry point: reads Claude Code's hook input JSON from stdin and, if the
// loop is enabled and under its round cap, prints {"decision":"block","reason":...}
// so Claude keeps going instead of stopping. Printing nothing (and exiting 0) lets
// Claude stop normally, which is the correct behavior for every "not looping" case.
function runHook(chunks) {
  let data = {};
  try {
    data = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    data = {};
  }

  const dir = data.cwd || process.cwd();
  const state = readState(dir);
  if (!state || !state.enabled) return; // not looping here: allow stop

  // Defense in depth alongside our own round counter: never re-block once Claude
  // Code reports this Stop hook already triggered a continuation for this turn.
  if (data.stop_hook_active === true) return;

  if (state.currentRound >= state.maxRounds) {
    state.enabled = false;
    writeState(dir, state);
    return; // round cap reached: allow stop, loop is over
  }

  state.currentRound += 1;

  let pushNote = '';
  if (state.push) {
    const result = autoCommitAndPush(dir, state.currentRound, state.maxRounds);
    if (!result.ok) pushNote = ` [auto-push failed: ${result.reason}]`;
  }

  writeState(dir, state);

  const reason = `${state.prompt} (auto-loop round ${state.currentRound}/${state.maxRounds})${pushNote}`;
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

async function install() {
  const claudeDir = path.join(os.homedir(), '.claude');
  const targetScript = path.join(claudeDir, 'loopctl.js');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const sourceContent = fs.readFileSync(__filename, 'utf8');

  fs.mkdirSync(claudeDir, { recursive: true });

  let copyScript = true;
  if (fs.existsSync(targetScript)) {
    const existingContent = fs.readFileSync(targetScript, 'utf8');
    if (existingContent === sourceContent) {
      console.log('loopctl.js is already up to date, nothing to install.');
      copyScript = false;
    } else {
      copyScript = await promptYesNo(`Found an existing loopctl.js (${targetScript}), update it?`);
      if (!copyScript) console.log('Update cancelled, existing file kept.');
    }
  }

  if (copyScript) {
    fs.writeFileSync(targetScript, sourceContent);
    console.log(`Installed loopctl.js to ${targetScript}`);
  }

  const commandPath = targetScript.split(path.sep).join('/');
  const desiredCommand = `node "${commandPath}" --hook`;

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      settings = {};
    }
  }

  settings.hooks = settings.hooks || {};
  settings.hooks.Stop = settings.hooks.Stop || [];

  const alreadyRegistered = settings.hooks.Stop.some(
    group => Array.isArray(group.hooks) && group.hooks.some(h => h.command === desiredCommand)
  );

  if (alreadyRegistered) {
    console.log('Stop hook already registered in settings.json.');
    return;
  }

  // Stop supports multiple hooks side by side (every matching hook runs to
  // completion), so this appends a new entry rather than replacing existing
  // Stop hooks that may already be configured for other purposes.
  settings.hooks.Stop.push({ hooks: [{ type: 'command', command: desiredCommand }] });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`Registered Stop hook in ${settingsPath}`);
}

function printUsage() {
  console.log(`Usage:
  loopctl on [--max N] [--push] [--no-push] [--preset <name>] [--prompt "text"]   enable the loop for this project
  loopctl off                                                                     disable the loop for this project
  loopctl status                                                                  show current loop state
  loopctl presets                                                                 list built-in --preset prompts
  loopctl --install                                                               install as a global tool + Stop hook`);
}

const args = process.argv.slice(2);

if (args.includes('--install')) {
  install().catch(err => {
    console.error('Install failed:', err.message);
    process.exitCode = 1;
  });
} else if (args.includes('--hook')) {
  const chunks = [];
  process.stdin.on('data', d => chunks.push(d));
  process.stdin.on('end', () => runHook(chunks));
} else if (args[0] === 'on') {
  cmdOn(process.cwd(), args.slice(1));
} else if (args[0] === 'off') {
  cmdOff(process.cwd());
} else if (args[0] === 'status') {
  cmdStatus(process.cwd());
} else if (args[0] === 'presets') {
  cmdPresets();
} else {
  printUsage();
}
