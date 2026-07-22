#!/usr/bin/env node
// Fetches model pricing from the community-maintained litellm price table
// (https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json),
// extracts the models you care about, converts per-token USD rates to
// per-million-token rates, and writes/merges them into ~/.claude/pricing.json
// in the shape statusline.js reads: { "<model>": { in, out, cacheRead, cacheWrite } }.
//
// Each litellm entry carries a `source` field pointing at the provider's official
// pricing page, so the data is ultimately sourced from official pages even though
// the table itself is community-maintained. This is the closest thing to an
// "official real-time" pricing source — Anthropic and MiniMax do not publish a
// JSON pricing API, only HTML pages.
//
// Run MANUALLY whenever you want fresh rates. There is deliberately NO scheduled
// task / cron / auto-update: silently rewriting rate data in the background (with
// the network and trust risks that entails) is not something this tool does for
// you. The status line itself never hits the network — it only reads the cached
// pricing.json, so renders stay fast and never block on a fetch.
//
// Usage:
//   node pricing-updater.js                 fetch all mainstream providers' canonical chat models, merge into ~/.claude/pricing.json
//   node pricing-updater.js --model KEY     also include a specific litellm key (repeatable)
//   node pricing-updater.js --list [pat]    print matching litellm keys + rates, write nothing
//   node pricing-updater.js --overwrite     replace the target file entirely instead of merging
//   node pricing-updater.js --out PATH     write to PATH instead of ~/.claude/pricing.json
//                                           (maintainer: --out pricing.json refreshes the repo's shipped copy)
//   node pricing-updater.js --source URL    use a different source URL

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const SOURCE_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const PRICING_FILE = path.join(os.homedir(), '.claude', 'pricing.json');

// Convert a litellm per-token rate to per-million-token USD, rounded to 6 dp.
function perM(perToken) {
  if (typeof perToken !== 'number' || !isFinite(perToken)) return 0;
  return Math.round(perToken * 1e6 * 1e6) / 1e6;
}

// Build a pricing.json entry from a litellm entry.
function entryFromLitellm(e) {
  return {
    in: perM(e.input_cost_per_token),
    out: perM(e.output_cost_per_token),
    cacheRead: perM(e.cache_read_input_token_cost ?? e.cache_read_input_token_cost ?? 0),
    cacheWrite: perM(e.cache_creation_input_token_cost ?? 0),
  };
}

// Friendly key = substring after the last '/', so "minimax/MiniMax-M3" -> "MiniMax-M3"
// and "claude-sonnet-5" stays as-is. This matches the model name Claude Code reports.
function friendlyKey(litellmKey) {
  const idx = litellmKey.lastIndexOf('/');
  return idx >= 0 ? litellmKey.slice(idx + 1) : litellmKey;
}

// Mainstream providers whose canonical chat models we want in pricing.json.
// Covers all the model families a user is likely to route to via ANTHROPIC_BASE_URL
// or use directly — even if the user only runs MiniMax/Claude today, shipping the
// full mainstream set means the cost figure stays correct if they switch models.
//
// litellm keys are inconsistent: some providers use bare keys (no '/'), others use
// a single '<provider>/' prefix, and EVERY model also exists under hoster/region
// variants (bedrock/<region>/..., vertex_ai/..., openrouter/..., azure/...,
// fireworks_ai/..., together_ai/..., deepinfra/...) that we must NOT pick — they
// collide on the friendly key and just duplicate the canonical price.
//
// So for each mainstream provider we take exactly one canonical form:
//   - bare keys  : anthropic (claude-*), openai (gpt-*/o*/chatgpt-*/codex-*),
//                  vertex_ai-language-models (gemini-*), deepseek (deepseek-*),
//                  cohere (command*)
//   - prefixed   : minimax/MiniMax-*, meta_llama/Llama-*, mistral/*,
//                  xai/grok-*, dashscope/qwen-*
// DeepSeek is a special case: it has BOTH bare (deepseek-chat) and deepseek/ keys;
// we take the bare form and exclude deepseek/ via the prefix list, so the friendly
// key "deepseek-chat" resolves to one entry.
const MAINSTREAM_PROVIDERS = new Set([
  'anthropic',
  'openai',
  'vertex_ai-language-models', // bare gemini-* (the clean canonical Gemini names)
  'minimax',
  'deepseek',
  'meta_llama',
  'mistral',
  'xai',
  'cohere',
  'dashscope', // Alibaba Qwen direct
]);
// Single-slash prefixes that are themselves canonical (not hoster/region variants).
const CANONICAL_PREFIXES = [
  'minimax/',
  'meta_llama/',
  'mistral/',
  'xai/',
  'dashscope/',
];

// A key is canonical if it is bare (no '/'), or has exactly one '/' and that slash
// starts one of the canonical prefixes. Anything with 2+ slashes is a regional
// duplicate (bedrock/<region>/..., etc.); ft: prefixes are OpenAI fine-tunes.
function isCanonicalKey(key) {
  if (key.startsWith('ft:')) return false;
  const slashes = (key.match(/\//g) || []).length;
  if (slashes === 0) return true;
  if (slashes !== 1) return false;
  return CANONICAL_PREFIXES.some(p => key.startsWith(p));
}

// Default extraction: every canonical chat model from a mainstream provider.
// Dedupes by friendly key, preferring bare (no-slash) entries so a collision like
// deepseek-chat (bare) vs deepseek/deepseek-chat resolves to the bare one — though
// the prefix list already excludes deepseek/, the dedup is a backstop for any
// provider that ships both forms.
function defaultKeys(table) {
  const byFriendly = new Map(); // friendlyKey -> { key, bare }
  for (const key of Object.keys(table)) {
    const e = table[key];
    if (!e || e.mode !== 'chat') continue;
    if (!MAINSTREAM_PROVIDERS.has(e.litellm_provider)) continue;
    if (!isCanonicalKey(key)) continue;
    const fk = friendlyKey(key);
    const bare = !key.includes('/');
    const prev = byFriendly.get(fk);
    if (!prev || (bare && !prev.bare)) byFriendly.set(fk, { key, bare });
  }
  return [...byFriendly.values()].map(v => v.key);
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const getter = u => {
      https
        .get(u, res => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return getter(res.headers.location);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} fetching ${u}`));
          }
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (err) {
              reject(new Error(`failed to parse JSON: ${err.message}`));
            }
          });
        })
        .on('error', reject);
    };
    getter(url);
  });
}

function readExisting(file) {
  try {
    if (!fs.existsSync(file)) return {};
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function formatEntry(e) {
  return `in:$${e.in}/M out:$${e.out}/M cacheRead:$${e.cacheRead}/M cacheWrite:$${e.cacheWrite}/M`;
}

async function main() {
  const args = process.argv.slice(2);
  const extraModels = [];
  let listPattern = null;
  let overwrite = false;
  let sourceUrl = SOURCE_URL;
  let outFile = PRICING_FILE; // default: the user's installed copy

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--model') extraModels.push(args[++i]);
    else if (a === '--list') listPattern = args[++i] || '';
    else if (a === '--overwrite') overwrite = true;
    else if (a === '--source') sourceUrl = args[++i];
    else if (a === '--out') outFile = args[++i];
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  pricing-updater.js                 fetch all mainstream providers' canonical chat models, merge into ~/.claude/pricing.json
  pricing-updater.js --model KEY     also include a specific litellm key (repeatable)
  pricing-updater.js --list [pat]    print matching litellm keys + rates, write nothing
  pricing-updater.js --overwrite     replace the target file entirely instead of merging
  pricing-updater.js --out PATH     write to PATH instead of ~/.claude/pricing.json
                                    (maintainer: use --out pricing.json to refresh the repo's shipped copy)
  pricing-updater.js --source URL    use a different source URL

Run manually whenever you want fresh rates. The status line picks up changes on
its next render. (No scheduled task is registered — by design, since silently
overwriting rates in the background is risky.)`);
      return;
    }
  }

  console.log(`Fetching pricing from ${sourceUrl} ...`);
  let table;
  try {
    table = await fetchJson(sourceUrl);
  } catch (err) {
    console.error(`Fetch failed: ${err.message}`);
    console.error('Pricing file left unchanged.');
    process.exitCode = 1;
    return;
  }
  console.log(`Fetched ${Object.keys(table).length} models.`);

  // --list: print and exit, write nothing.
  if (listPattern !== null) {
    const re = new RegExp(listPattern, 'i');
    const matches = Object.keys(table).filter(k => re.test(k));
    console.log(`\n${matches.length} key(s) match "${listPattern}":`);
    for (const k of matches.slice(0, 200)) {
      const e = table[k];
      if (!e) continue;
      console.log(`  ${k}  ${formatEntry(entryFromLitellm(e))}  src=${e.source || '?'}`);
    }
    if (matches.length > 200) console.log(`  ... and ${matches.length - 200} more`);
    return;
  }

  const wanted = new Set([...defaultKeys(table), ...extraModels]);
  const fetched = {};
  const report = [];
  for (const key of wanted) {
    const e = table[key];
    if (!e) {
      report.push(`  ! ${key} not found in source (skipped)`);
      continue;
    }
    if (e.mode && e.mode !== 'chat') {
      report.push(`  - ${key} (mode=${e.mode}, skipped)`);
      continue;
    }
    const fk = friendlyKey(key);
    fetched[fk] = entryFromLitellm(e);
    report.push(`  + ${fk}  ${formatEntry(fetched[fk])}  src=${e.source || '?'}`);
  }

  const existing = overwrite ? {} : readExisting(outFile);
  const merged = { ...existing, ...fetched };

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(merged, null, 2) + '\n', 'utf8');

  console.log(`\n${overwrite ? 'Wrote' : 'Merged into'} ${outFile} (${Object.keys(merged).length} entries):`);
  console.log(report.join('\n'));
  console.log(`\nDone. The status line picks this up on its next render.`);
}

main().catch(err => {
  console.error('Updater failed:', err.message);
  process.exitCode = 1;
});