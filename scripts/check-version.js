#!/usr/bin/env node
// Verifies statusline.js's embedded VERSION const matches package.json. The const
// must be embedded (--install copies the script to ~/.claude/statusline.js, where
// no package.json sits beside it), so this check is what keeps the two in sync.

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
console.log(`version sync ok: ${pkg.version}`);
