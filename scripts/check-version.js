#!/usr/bin/env node
// Version-sync checks before publish:
//  - statusline.js's embedded VERSION const must match package.json (the const
//    is embedded because the --install copy at ~/.claude/statusline.js has no
//    package.json beside it)
//  - mod/.claude-plugin/plugin.json (the companion mod's manifest) must match too

const fs = require('fs');

const pkg = require('../package.json');
const src = fs.readFileSync(require.resolve('../statusline.js'), 'utf8');
const m = src.match(/const VERSION = '([^']+)'/);
const embedded = m ? m[1] : null;

if (embedded !== pkg.version) {
  console.error(
    `version drift: statusline.js VERSION is ${embedded === null ? 'missing' : embedded}, package.json is ${pkg.version}`
  );
  process.exit(1);
}

const manifestPath = require.resolve('../mod/.claude-plugin/plugin.json');
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== pkg.version) {
    console.error(
      `version drift: mod manifest is ${manifest.version}, package.json is ${pkg.version}`
    );
    process.exit(1);
  }
}

console.log(`version sync ok: ${pkg.version}`);
