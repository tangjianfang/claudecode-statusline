#!/usr/bin/env node
// npm postinstall: wire the status line into Claude Code automatically.
// Runs statusline.js's --install flow with --yes so the existing overwrite
// prompts auto-confirm — this is what makes `npm install -g` a one-shot.
// We intentionally keep the prompts in the manual --install flow (run
// `cc-statusline --install` yourself to get them back); --yes is only
// passed from THIS script.
//
// Also cleans up loopctl, which lived in this package up to v1.x: Claude Code
// now has native `/goal`, so the auto-continue loop was removed. Best-effort:
// deregister its Stop hook, and delete the copies this package once installed.
//
// Errors here are non-fatal: if we can't write to ~/.claude (sandboxed
// env, permission issue, etc.) we log and exit 0 so the npm install
// still succeeds — the bins are already on PATH and the user can run
// `cc-statusline --install` manually to finish wiring.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function runInstall(script) {
  const r = spawnSync(
    process.execPath,
    [path.join(__dirname, '..', script), '--install', '--yes'],
    { stdio: 'inherit' }
  );
  if (r.error || (r.status !== 0 && r.status !== null)) {
    console.error(`\n[postinstall] ${script} --install did not complete (status=${r.status}).`);
    console.error('[postinstall] The npm bins are installed and on PATH; you can wire Claude Code manually:');
    console.error(`[postinstall]   ${path.join(__dirname, '..', script)} --install`);
    return false;
  }
  return true;
}

// Remove v1.x leftovers: the loopctl Stop hook registration in settings.json
// and the files this package used to install. Only touches entries whose
// command references loopctl.js — other Stop hooks are left untouched.
function cleanupLoopctl() {
  const claudeDir = path.join(os.homedir(), '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  let removed = false;

  try {
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (Array.isArray(settings.hooks && settings.hooks.Stop)) {
        const before = settings.hooks.Stop.length;
        settings.hooks.Stop = settings.hooks.Stop.filter(
          group => !(
            group && Array.isArray(group.hooks) &&
            group.hooks.some(h => h && typeof h.command === 'string' && h.command.includes('loopctl.js'))
          )
        );
        if (settings.hooks.Stop.length !== before) {
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
          removed = true;
        }
      }
    }
  } catch (err) {
    console.error(`[postinstall] Could not clean loopctl from settings.json: ${err.message}`);
  }

  for (const name of ['loopctl.js', 'loop-state.json']) {
    try {
      const p = path.join(claudeDir, name);
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        removed = true;
      }
    } catch (err) {
      console.error(`[postinstall] Could not remove ~/.claude/${name}: ${err.message}`);
    }
  }

  if (removed) {
    console.log('[postinstall] Removed loopctl (v1.x auto-continue loop). Claude Code has native /goal now;');
    console.log('[postinstall] per-project .claude/loop-state.json files, if any, are inert and safe to delete.');
  }
}

console.log('[postinstall] Wiring status line into Claude Code...');
runInstall('statusline.js');
cleanupLoopctl();

// First-run panel: show the user what's now available and where to find
// more — they shouldn't have to read the README to discover commands.
console.log(`
[postinstall] ✅ Status line is wired into Claude Code.

Quick reference (run any of these for the full list):
  cc-statusline --help        status line command reference
  pricing-updater --help      pricing refresh reference

Most common commands:
  cc-statusline status               show what's wired
  pricing-updater                    refresh model pricing rates

Restart Claude Code to see the new status line.
`);
