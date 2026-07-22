#!/usr/bin/env node
// npm postinstall: wire statusline + loopctl into Claude Code automatically.
// Runs each tool's --install flow with --yes so the existing overwrite
// prompts auto-confirm — this is what makes `npm install -g` a one-shot.
// We intentionally keep the prompts in the manual --install flow (run
// `cc-statusline --install` yourself to get them back); --yes is only
// passed from THIS script.
//
// Errors here are non-fatal: if we can't write to ~/.claude (sandboxed
// env, permission issue, etc.) we log and exit 0 so the npm install
// still succeeds — the bins are already on PATH and the user can run
// the two --install commands manually to finish wiring.
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

console.log('[postinstall] Wiring status line + loopctl into Claude Code...');
runInstall('statusline.js');
runInstall('loopctl.js');
console.log('[postinstall] Done. Restart Claude Code to see the status line.');
console.log('[postinstall] Enable the loop in any project with: loopctl on --max 8 --push');
