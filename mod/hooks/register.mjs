// cc-statusline companion mod — quick actions + per-request usage stats.
//
// Runs INSIDE Claude Code (a plugin "mod"), unlike statusline.js which is a
// subprocess. That buys two things the status line can't do:
//   * a single toggle button above the prompt (the AbovePrompt band) that
//     opens a one-view launcher of quick-action buttons, each with its hotkey,
//   * direct sight of every model request via `turn.step`, so usage stats
//     arrive with zero transcript parsing.
//
// The launcher is ONE VIEW: every function on screen at once, nothing behind
// a tab or a second click. Sections stack with colored bold headers
// (⚡快捷切换 ✏提示词 🔗链接 $命令, custom ◆ sections after); 快捷 and 提示词
// lay out two columns, links and commands one per line (bookmarks show their
// address; finished commands render their result inline). If the engine won't
// place the pane (opens outside the person's press dispatch wait undrawn
// below 144 columns; open() then answers { isPlaced: false, reason }), the
// same view expands INLINE in the band — reachable at any width, the engine's
// reason toasted rather than swallowed.
//
// Custom buttons: ~/.claude/ccsl-buttons.json (auto-created with a working
// engineering template — mode switches, 10 daily prompts, real git/npm
// commands; /ccsl-buttons reloads it). The band carries only the toggle
// (restyled via "toggle"). Each button is one of:
//   { label, hotkey, pane:   "ccsl-usage" }                  open a mod pane
//   { label, hotkey, slash:  "fast" }        fill "/fast" — Enter runs it
//                                            (interactive commands like /model
//                                            only run from the person's Enter;
//                                            permissions opens CC's dialog, the
//                                            API has no mode setter yet)
//   { label, hotkey, prompt: "text" }        fill the prompt — Enter sends it
//   { label, hotkey, url:    "https://..." }                 open in browser
//   { label, hotkey, run:    ["npm", "test"] }               host command
//   { label, hotkey, ..., group: "name" }                    own section
// Nothing a person hasn't confirmed runs: slash/prompt buttons FILL the
// composer (result checked, refusal toasted) and close the launcher — a
// picked action means back to the conversation. The other kinds keep it
// open. Hotkeys are the launcher's keyboard: they should stay unique across
// ALL buttons (only the rendered view can fire them, but one key = one
// function reads cleanest).
//
// API discipline (learned from Claude Code's module validator + runtime):
//   * $ nouns ($.store, $.ui, $.command, $.fs, $.process, $.prompt) must be
//     CALLED, never read as values or passed to helpers — call them where the
//     handler bound them, duplicate small loaders rather than factor them out.
//   * streaming events (turn.step) take an async generator: yield* the chunks
//     through, record usage, return the result.
//   * draw sites (Pane body, AbovePrompt band) are ANSWERED: the hook returns
//     the element tree it wants drawn. next(e) resolves to what the rest of
//     the chain drew — wrap it to compose.
//   * command.run matches on { command: <name> }, answers with { text }, and
//     its registration needs a .catch (it's a gating event).
//   * the engine only credits a pane open to the person's press while the
//     call leaves the press dispatch: the toggle decides from tracked state
//     and issues open/close SYNCHRONOUSLY (never after an await), then reads
//     the result's isPlaced for the inline fallback.
//   * every button action toasts — a silent failure is an undiagnosable one.
// Anything that fails here degrades to "not shown" and never breaks a turn.

const PANE = 'ccsl-usage';
const BUTTONS_PANE = 'ccsl-buttons';
const MAX_POINTS = 240;

// Per-request usage records: [{ ts, out, in, cacheR, cacheW, cost?, ctx? }]
let history = [];

// Pricing table (~/.claude/pricing.json — the same file the status line
// reads and pricing-updater refreshes) and cost accumulated across sessions.
let pricing = null;
let costAll = 0; // dollars, persisted via $.store

// Context-budget alerting: ctxWindow is the model's window (config
// "contextWindow", default 200k); a request's in+cacheR approximates the
// context it sat in. Each threshold toasts once per fill cycle.
let ctxWindow = 200000;
let warnedCtx = 0;

// Loaded button config (module state; session.start + /ccsl-buttons load it).
let buttons = null;
let toggle = null;

// Launcher visibility. paneUp tracks the engine's pane (refreshed from
// $.ui.panes() at every band draw, set by our own open/close); inlineUp is
// the band-embedded fallback used when the engine won't place the pane.
let paneUp = false;
let inlineUp = false;

// Last finished host command, rendered inline under the $命令 section.
let lastRun = null;

// Run fn, swallow any throw, return fallback. Mods must never break a turn.
async function safe(fn, fallback) {
  try {
    const v = await fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

// Extract a usage record from whatever shape an event/result hands us.
function usageFrom(e) {
  const u =
    (e && (e.usage || (e.response && e.response.usage) || (e.result && e.result.usage))) ||
    null;
  if (!u || typeof u.output_tokens !== 'number') return null;
  return {
    ts: Date.now(),
    out: u.output_tokens,
    in: u.input_tokens || 0,
    cacheR: u.cache_read_input_tokens || 0,
    cacheW: u.cache_creation_input_tokens || 0,
  };
}

function totals() {
  return history.reduce(
    (a, r) => ({
      out: a.out + r.out,
      in: a.in + r.in,
      cacheR: a.cacheR + r.cacheR,
      cacheW: a.cacheW + r.cacheW,
      cost: a.cost + (r.cost || 0),
    }),
    { out: 0, in: 0, cacheR: 0, cacheW: 0, cost: 0 }
  );
}

// Pricing-model resolution, ported from statusline.js: exact name, then the
// longest case-insensitive substring (so "glm-5.3[1m]" matches "glm-5.3").
// rates: per-1M-token dollars { in, out, cacheRead, cacheWrite }.
function resolvePricing(model, table) {
  if (!model || !table) return null;
  if (table[model]) return table[model];
  const lower = model.toLowerCase();
  let best = null;
  for (const key of Object.keys(table)) {
    if (lower.includes(key.toLowerCase()) && (!best || key.length > best.length)) best = key;
  }
  return best ? table[best] : null;
}

// Dollars for one usage record: per-1M rates × token counts.
function computeCost(rec, rates) {
  const micros =
    (rates.in || 0) * rec.in +
    (rates.out || 0) * rec.out +
    (rates.cacheRead || 0) * rec.cacheR +
    (rates.cacheWrite || 0) * rec.cacheW;
  return micros / 1e6;
}

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

// Unicode sparkline: one bar per value, scaled to the tallest.
const BARS = '▁▂▃▄▅▆▇█';
function spark(vals) {
  if (!vals.length) return '';
  const max = Math.max(...vals, 1);
  return vals
    .map(v => BARS[Math.min(BARS.length - 1, Math.floor((v / max) * BARS.length))])
    .join('');
}

// Code-point-safe truncation — a UTF-16 .slice() through an emoji leaves a
// lone surrogate half, which the engine draws as U+FFFD.
function clip(s, n) {
  return Array.from(s).slice(0, n).join('');
}

// The default buttons, used until a config file exists.
function defaultButtons() {
  return [
    { label: '快速模式', hotkey: 'f', slash: 'fast' },
    { label: '权限设置', hotkey: 'p', slash: 'permissions' },
    { label: '用量面板', hotkey: 'u', pane: PANE },
  ];
}

// The band's one toggle button — the launcher stays one keypress away even
// with everything else customized away. The glyph is a one-glyph LABEL with
// variant primary (never a styled Text child): the engine then draws it in
// the theme's accent color AND inverts the whole button under the focus and
// the pointer — a styled child keeps its own color and the selection state
// lands beside the icon instead of on it (real-machine-verified).
function defaultToggle() {
  // ＊ is fullwidth — exactly two cells on every terminal, so it sits dead
  // center inside the button's brackets. ✳ (U+2733) is East-Asian-ambiguous:
  // engines count one cell, CJK-configured fonts draw two, and the right
  // bracket drifts (real-machine-verified).
  return { label: '＊', hotkey: 'm' };
}

function configTemplate() {
  return `${JSON.stringify(
    {
      _doc: 'cc-statusline mod buttons. The band shows one toggle; it opens the one-view launcher. Actions: pane=<pane id> | slash=<command> (fills /<command> — Enter runs it; permissions opens CC dialog, no mode setter API yet) | prompt=<text> (fills the composer — Enter sends; nothing runs unconfirmed) | url=<https://...> | run=[argv]. Sections by type: slash/pane=⚡快捷切换 prompt=✏提示词 url=🔗链接 run=$命令; group=<name> gives a button its own section. toggle restyles the band button (label/hotkey). contextWindow: model context window in tokens, for the 80%/90% budget alerts (default 200000). hotkey: one digit/lowercase letter, works while the site (band or pane) holds focus — keep them unique across all buttons. Reload with /ccsl-buttons.',
      toggle: { label: '＊', hotkey: 'm' },
      contextWindow: 200000,
      buttons: [
        { label: '快速模式', hotkey: 'f', slash: 'fast' },
        { label: '权限设置', hotkey: 'p', slash: 'permissions' },
        { label: '模型选择', hotkey: 'o', slash: 'model' },
        { label: '压缩上下文', hotkey: 'k', slash: 'compact' },
        { label: '用量面板', hotkey: 'u', pane: PANE },
        { label: '继续任务', hotkey: 'n', prompt: '继续上次中断的任务：先回顾我们最近在做什么，然后接着完成。' },
        { label: '测试并修复', hotkey: 't', prompt: '运行完整测试套件；若有失败：定位根因后修复，再跑一遍直到全绿。总结改了什么。' },
        { label: '审查改动', hotkey: 'r', prompt: '审查当前 git diff：找正确性 bug、边界情况和安全隐患，按严重程度列出，先不改代码。' },
        { label: '修复告警', hotkey: 'l', prompt: '运行 lint 和类型检查，修复所有告警，不改变行为。' },
        { label: '重构文件', hotkey: 'w', prompt: '重构当前文件：提高可读性、消除重复，不改变任何行为；改完运行测试验证。' },
        { label: '补文档', hotkey: 'd', prompt: '为刚才的改动更新文档：面向新用户，简明，附使用示例。' },
        { label: '写提交', hotkey: 's', prompt: '把当前改动写成一条 conventional commit 并提交（不要推送），提交信息说明为什么这样改。' },
        { label: '定位bug', hotkey: 'b', prompt: '根据我贴的错误信息系统性定位根因：先复现、再缩小范围；修复前先说明根因。' },
        { label: '性能分析', hotkey: 'q', prompt: '找出当前最热路径的性能瓶颈：先测量再优化，给出前后对比数据。' },
        { label: '解释架构', hotkey: 'x', prompt: '解释这个仓库：模块划分、关键数据流、要改某类东西该去哪里，面向新人。' },
        { label: '仓库', hotkey: 'a', url: 'https://github.com/tangjianfang/claudecode-statusline' },
        { label: '议题', hotkey: 'i', url: 'https://github.com/tangjianfang/claudecode-statusline/issues' },
        { label: 'git状态', hotkey: 'g', run: ['git', 'status', '-sb'] },
        { label: '同步拉取', hotkey: 'y', run: ['git', 'pull', '--ff-only'] },
        { label: '语法检查', hotkey: 'j', run: ['npm', 'run', 'check'] },
        { label: '构建示例', hotkey: 'v', run: ['npm', 'run', 'build'] },
        { label: '其他命令', hotkey: 'z', group: 'misc', run: ['node', '--version'] },
      ],
    },
    null,
    2
  )}\n`;
}


// Byte-exact factory templates of past versions. A config file that matches
// one was never hand-edited — upgrade it to the current template instead of
// leaving a stale demo behind (a hand-edited file never matches and is always
// preserved). When configTemplate() changes, append the outgoing template.
const LEGACY_TEMPLATES = [
`{
  "_doc": "cc-statusline mod buttons. The band shows one toggle; it opens the one-view launcher. Actions: pane=<pane id> | slash=<command> (fills /<command> — Enter runs it; permissions opens CC dialog, no mode setter API yet) | prompt=<text> (fills the composer — Enter sends; nothing runs unconfirmed) | url=<https://...> | run=[argv]. Sections by type: slash/pane=⚡快捷切换 prompt=✏提示词 url=🔗链接 run=$命令; group=<name> gives a button its own section. toggle restyles the band button (label/hotkey). hotkey: one digit/lowercase letter, works while the site (band or pane) holds focus — keep them unique across all buttons. Reload with /ccsl-buttons.",
  "toggle": {
    "label": "✳",
    "hotkey": "m"
  },
  "buttons": [
    {
      "label": "快速模式",
      "hotkey": "f",
      "slash": "fast"
    },
    {
      "label": "权限设置",
      "hotkey": "p",
      "slash": "permissions"
    },
    {
      "label": "模型选择",
      "hotkey": "o",
      "slash": "model"
    },
    {
      "label": "压缩上下文",
      "hotkey": "k",
      "slash": "compact"
    },
    {
      "label": "用量面板",
      "hotkey": "u",
      "pane": "ccsl-usage"
    },
    {
      "label": "继续任务",
      "hotkey": "n",
      "prompt": "继续上次中断的任务：先回顾我们最近在做什么，然后接着完成。"
    },
    {
      "label": "测试并修复",
      "hotkey": "t",
      "prompt": "运行完整测试套件；若有失败：定位根因后修复，再跑一遍直到全绿。总结改了什么。"
    },
    {
      "label": "审查改动",
      "hotkey": "r",
      "prompt": "审查当前 git diff：找正确性 bug、边界情况和安全隐患，按严重程度列出，先不改代码。"
    },
    {
      "label": "修复告警",
      "hotkey": "l",
      "prompt": "运行 lint 和类型检查，修复所有告警，不改变行为。"
    },
    {
      "label": "重构文件",
      "hotkey": "w",
      "prompt": "重构当前文件：提高可读性、消除重复，不改变任何行为；改完运行测试验证。"
    },
    {
      "label": "补文档",
      "hotkey": "d",
      "prompt": "为刚才的改动更新文档：面向新用户，简明，附使用示例。"
    },
    {
      "label": "写提交",
      "hotkey": "s",
      "prompt": "把当前改动写成一条 conventional commit 并提交（不要推送），提交信息说明为什么这样改。"
    },
    {
      "label": "定位bug",
      "hotkey": "b",
      "prompt": "根据我贴的错误信息系统性定位根因：先复现、再缩小范围；修复前先说明根因。"
    },
    {
      "label": "性能分析",
      "hotkey": "q",
      "prompt": "找出当前最热路径的性能瓶颈：先测量再优化，给出前后对比数据。"
    },
    {
      "label": "解释架构",
      "hotkey": "x",
      "prompt": "解释这个仓库：模块划分、关键数据流、要改某类东西该去哪里，面向新人。"
    },
    {
      "label": "仓库",
      "hotkey": "a",
      "url": "https://github.com/tangjianfang/claudecode-statusline"
    },
    {
      "label": "议题",
      "hotkey": "i",
      "url": "https://github.com/tangjianfang/claudecode-statusline/issues"
    },
    {
      "label": "git状态",
      "hotkey": "g",
      "run": [
        "git",
        "status",
        "-sb"
      ]
    },
    {
      "label": "同步拉取",
      "hotkey": "y",
      "run": [
        "git",
        "pull",
        "--ff-only"
      ]
    },
    {
      "label": "语法检查",
      "hotkey": "j",
      "run": [
        "npm",
        "run",
        "check"
      ]
    },
    {
      "label": "构建示例",
      "hotkey": "v",
      "run": [
        "npm",
        "run",
        "build"
      ]
    },
    {
      "label": "其他命令",
      "hotkey": "z",
      "group": "misc",
      "run": [
        "node",
        "--version"
      ]
    }
  ]
}
`,
`{
  "_doc": "cc-statusline mod buttons. The band shows one toggle; it opens the one-view launcher. Actions: pane=<pane id> | slash=<command> (submits /<command>; permissions opens CC dialog — no mode setter API yet) | prompt=<text> (+submit:true to send at once) | url=<https://...> | run=[argv]. Sections by type: slash/pane=⚡快捷切换 prompt=✏提示词 url=🔗链接 run=$命令; group=<name> gives a button its own section. toggle restyles the band button. hotkey: one digit/lowercase letter, works while the site (band or pane) holds focus — keep them unique across all buttons. Reload with /ccsl-buttons.",
  "toggle": {
    "label": "✳",
    "hotkey": "m",
    "color": "#D97757"
  },
  "buttons": [
    {
      "label": "快速模式",
      "hotkey": "f",
      "slash": "fast"
    },
    {
      "label": "权限设置",
      "hotkey": "p",
      "slash": "permissions"
    },
    {
      "label": "模型选择",
      "hotkey": "o",
      "slash": "model"
    },
    {
      "label": "压缩上下文",
      "hotkey": "k",
      "slash": "compact"
    },
    {
      "label": "用量面板",
      "hotkey": "u",
      "pane": "ccsl-usage"
    },
    {
      "label": "继续任务",
      "hotkey": "n",
      "prompt": "继续上次中断的任务：先回顾我们最近在做什么，然后接着完成。",
      "submit": true
    },
    {
      "label": "测试并修复",
      "hotkey": "t",
      "prompt": "运行完整测试套件；若有失败：定位根因后修复，再跑一遍直到全绿。总结改了什么。",
      "submit": true
    },
    {
      "label": "审查改动",
      "hotkey": "r",
      "prompt": "审查当前 git diff：找正确性 bug、边界情况和安全隐患，按严重程度列出，先不改代码。",
      "submit": true
    },
    {
      "label": "修复告警",
      "hotkey": "l",
      "prompt": "运行 lint 和类型检查，修复所有告警，不改变行为。",
      "submit": true
    },
    {
      "label": "重构文件",
      "hotkey": "w",
      "prompt": "重构当前文件：提高可读性、消除重复，不改变任何行为；改完运行测试验证。",
      "submit": true
    },
    {
      "label": "补文档",
      "hotkey": "d",
      "prompt": "为刚才的改动更新文档：面向新用户，简明，附使用示例。",
      "submit": true
    },
    {
      "label": "写提交",
      "hotkey": "s",
      "prompt": "把当前改动写成一条 conventional commit 并提交（不要推送），提交信息说明为什么这样改。",
      "submit": true
    },
    {
      "label": "定位bug",
      "hotkey": "b",
      "prompt": "根据我贴的错误信息系统性定位根因：先复现、再缩小范围；修复前先说明根因。",
      "submit": true
    },
    {
      "label": "性能分析",
      "hotkey": "q",
      "prompt": "找出当前最热路径的性能瓶颈：先测量再优化，给出前后对比数据。",
      "submit": true
    },
    {
      "label": "解释架构",
      "hotkey": "x",
      "prompt": "解释这个仓库：模块划分、关键数据流、要改某类东西该去哪里，面向新人。",
      "submit": true
    },
    {
      "label": "仓库",
      "hotkey": "a",
      "url": "https://github.com/tangjianfang/claudecode-statusline"
    },
    {
      "label": "议题",
      "hotkey": "i",
      "url": "https://github.com/tangjianfang/claudecode-statusline/issues"
    },
    {
      "label": "git状态",
      "hotkey": "g",
      "run": [
        "git",
        "status",
        "-sb"
      ]
    },
    {
      "label": "同步拉取",
      "hotkey": "y",
      "run": [
        "git",
        "pull",
        "--ff-only"
      ]
    },
    {
      "label": "语法检查",
      "hotkey": "j",
      "run": [
        "npm",
        "run",
        "check"
      ]
    },
    {
      "label": "构建示例",
      "hotkey": "v",
      "run": [
        "npm",
        "run",
        "build"
      ]
    },
    {
      "label": "其他命令",
      "hotkey": "z",
      "group": "misc",
      "run": [
        "node",
        "--version"
      ]
    }
  ]
}
`,
`{
  "_doc": "cc-statusline mod buttons. The band shows one toggle; it opens the one-view launcher. Actions: pane=<pane id> | slash=<command> (submits /<command>; permissions opens CC dialog — no mode setter API yet) | prompt=<text> (+submit:true to send at once) | url=<https://...> | run=[argv]. Sections by type: slash/pane=⚡快捷切换 prompt=✏提示词 url=🔗链接 run=$命令; group=<name> gives a button its own section. toggle restyles the band button. hotkey: one digit/lowercase letter, works while the site (band or pane) holds focus — keep them unique across all buttons. Reload with /ccsl-buttons.",
  "toggle": {
    "label": "✳",
    "hotkey": "m",
    "color": "#D97757"
  },
  "buttons": [
    {
      "label": "⚡快速模式",
      "hotkey": "f",
      "slash": "fast"
    },
    {
      "label": "🔑权限设置",
      "hotkey": "p",
      "slash": "permissions"
    },
    {
      "label": "⚙模型选择",
      "hotkey": "o",
      "slash": "model"
    },
    {
      "label": "🗜压缩上下文",
      "hotkey": "k",
      "slash": "compact"
    },
    {
      "label": "📊用量面板",
      "hotkey": "u",
      "pane": "ccsl-usage"
    },
    {
      "label": "继续任务",
      "hotkey": "n",
      "prompt": "继续上次中断的任务：先回顾我们最近在做什么，然后接着完成。",
      "submit": true
    },
    {
      "label": "测试并修复",
      "hotkey": "t",
      "prompt": "运行完整测试套件；若有失败：定位根因后修复，再跑一遍直到全绿。总结改了什么。",
      "submit": true
    },
    {
      "label": "审查改动",
      "hotkey": "r",
      "prompt": "审查当前 git diff：找正确性 bug、边界情况和安全隐患，按严重程度列出，先不改代码。",
      "submit": true
    },
    {
      "label": "修复告警",
      "hotkey": "l",
      "prompt": "运行 lint 和类型检查，修复所有告警，不改变行为。",
      "submit": true
    },
    {
      "label": "重构文件",
      "hotkey": "w",
      "prompt": "重构当前文件：提高可读性、消除重复，不改变任何行为；改完运行测试验证。",
      "submit": true
    },
    {
      "label": "补文档",
      "hotkey": "d",
      "prompt": "为刚才的改动更新文档：面向新用户，简明，附使用示例。",
      "submit": true
    },
    {
      "label": "写提交",
      "hotkey": "s",
      "prompt": "把当前改动写成一条 conventional commit 并提交（不要推送），提交信息说明为什么这样改。",
      "submit": true
    },
    {
      "label": "定位bug",
      "hotkey": "b",
      "prompt": "根据我贴的错误信息系统性定位根因：先复现、再缩小范围；修复前先说明根因。",
      "submit": true
    },
    {
      "label": "性能分析",
      "hotkey": "q",
      "prompt": "找出当前最热路径的性能瓶颈：先测量再优化，给出前后对比数据。",
      "submit": true
    },
    {
      "label": "解释架构",
      "hotkey": "x",
      "prompt": "解释这个仓库：模块划分、关键数据流、要改某类东西该去哪里，面向新人。",
      "submit": true
    },
    {
      "label": "仓库",
      "hotkey": "a",
      "url": "https://github.com/tangjianfang/claudecode-statusline"
    },
    {
      "label": "议题",
      "hotkey": "i",
      "url": "https://github.com/tangjianfang/claudecode-statusline/issues"
    },
    {
      "label": "git状态",
      "hotkey": "g",
      "run": [
        "git",
        "status",
        "-sb"
      ]
    },
    {
      "label": "同步拉取",
      "hotkey": "y",
      "run": [
        "git",
        "pull",
        "--ff-only"
      ]
    },
    {
      "label": "语法检查",
      "hotkey": "j",
      "run": [
        "npm",
        "run",
        "check"
      ]
    },
    {
      "label": "构建示例",
      "hotkey": "v",
      "run": [
        "npm",
        "run",
        "build"
      ]
    },
    {
      "label": "其他命令",
      "hotkey": "z",
      "group": "misc",
      "run": [
        "node",
        "--version"
      ]
    }
  ]
}
`,
`{
  "_doc": "cc-statusline mod buttons. Actions: pane=<pane id> | prompt=<text> (+submit:true to send at once) | url=<https://...> | run=[argv]. hotkey: one digit/lowercase letter, works while the band holds focus (ctrl+x). Reload with /ccsl-buttons.",
  "buttons": [
    {
      "label": "usage",
      "hotkey": "u",
      "pane": "ccsl-usage"
    },
    {
      "label": "tokens",
      "hotkey": "c",
      "pane": "ccsl-usage"
    },
    {
      "label": "tests",
      "hotkey": "t",
      "prompt": "Run the full test suite and fix any failures.",
      "submit": false
    },
    {
      "label": "repo",
      "hotkey": "o",
      "url": "https://github.com/tangjianfang/claudecode-statusline"
    },
    {
      "label": "check",
      "hotkey": "k",
      "run": [
        "npm",
        "run",
        "check"
      ]
    }
  ]
}
`,
`{
  "_doc": "cc-statusline mod buttons. The band shows one toggle; it opens the one-view launcher. Actions: pane=<pane id> | slash=<command> (submits /<command>; permissions opens CC dialog — no mode setter API yet) | prompt=<text> (+submit:true to send at once) | url=<https://...> | run=[argv]. Sections by type: slash/pane=⚡快捷切换 prompt=✏提示词 url=🔗链接 run=$命令; group=<name> gives a button its own section. toggle restyles the band button. hotkey: one digit/lowercase letter, works while the site (band or pane) holds focus — keep them unique across all buttons. Reload with /ccsl-buttons.",
  "toggle": {
    "label": "🎛",
    "hotkey": "m"
  },
  "buttons": [
    {
      "label": "⚡快速模式",
      "hotkey": "f",
      "slash": "fast"
    },
    {
      "label": "🔑权限设置",
      "hotkey": "p",
      "slash": "permissions"
    },
    {
      "label": "⚙模型选择",
      "hotkey": "o",
      "slash": "model"
    },
    {
      "label": "🗜压缩上下文",
      "hotkey": "k",
      "slash": "compact"
    },
    {
      "label": "📊用量面板",
      "hotkey": "u",
      "pane": "ccsl-usage"
    },
    {
      "label": "继续任务",
      "hotkey": "n",
      "prompt": "继续上次中断的任务：先回顾我们最近在做什么，然后接着完成。",
      "submit": true
    },
    {
      "label": "测试并修复",
      "hotkey": "t",
      "prompt": "运行完整测试套件；若有失败：定位根因后修复，再跑一遍直到全绿。总结改了什么。",
      "submit": true
    },
    {
      "label": "审查改动",
      "hotkey": "r",
      "prompt": "审查当前 git diff：找正确性 bug、边界情况和安全隐患，按严重程度列出，先不改代码。",
      "submit": true
    },
    {
      "label": "修复告警",
      "hotkey": "l",
      "prompt": "运行 lint 和类型检查，修复所有告警，不改变行为。",
      "submit": true
    },
    {
      "label": "重构文件",
      "hotkey": "w",
      "prompt": "重构当前文件：提高可读性、消除重复，不改变任何行为；改完运行测试验证。",
      "submit": true
    },
    {
      "label": "补文档",
      "hotkey": "d",
      "prompt": "为刚才的改动更新文档：面向新用户，简明，附使用示例。",
      "submit": true
    },
    {
      "label": "写提交",
      "hotkey": "s",
      "prompt": "把当前改动写成一条 conventional commit 并提交（不要推送），提交信息说明为什么这样改。",
      "submit": true
    },
    {
      "label": "定位bug",
      "hotkey": "b",
      "prompt": "根据我贴的错误信息系统性定位根因：先复现、再缩小范围；修复前先说明根因。",
      "submit": true
    },
    {
      "label": "性能分析",
      "hotkey": "q",
      "prompt": "找出当前最热路径的性能瓶颈：先测量再优化，给出前后对比数据。",
      "submit": true
    },
    {
      "label": "解释架构",
      "hotkey": "x",
      "prompt": "解释这个仓库：模块划分、关键数据流、要改某类东西该去哪里，面向新人。",
      "submit": true
    },
    {
      "label": "仓库",
      "hotkey": "a",
      "url": "https://github.com/tangjianfang/claudecode-statusline"
    },
    {
      "label": "议题",
      "hotkey": "i",
      "url": "https://github.com/tangjianfang/claudecode-statusline/issues"
    },
    {
      "label": "git状态",
      "hotkey": "g",
      "run": [
        "git",
        "status",
        "-sb"
      ]
    },
    {
      "label": "同步拉取",
      "hotkey": "y",
      "run": [
        "git",
        "pull",
        "--ff-only"
      ]
    },
    {
      "label": "语法检查",
      "hotkey": "j",
      "run": [
        "npm",
        "run",
        "check"
      ]
    },
    {
      "label": "构建示例",
      "hotkey": "v",
      "run": [
        "npm",
        "run",
        "build"
      ]
    },
    {
      "label": "其他命令",
      "hotkey": "z",
      "group": "misc",
      "run": [
        "node",
        "--version"
      ]
    }
  ]
}
`,
];

// The upgraded template for an untouched legacy config file, else null.
function templateUpgrade(text) {
  return LEGACY_TEMPLATES.includes(text) ? configTemplate() : null;
}

// Normalize one config entry: label required, hotkey one digit/lowercase
// letter, exactly one action field, optional group. Returns null for junk.
function normalizeButton(b) {
  if (!b || typeof b.label !== 'string' || !b.label) return null;
  const out = { label: clip(b.label, 24) };
  if (typeof b.hotkey === 'string' && /^[0-9a-z]$/.test(b.hotkey)) out.hotkey = b.hotkey;
  if (typeof b.pane === 'string' && b.pane) out.pane = b.pane;
  else if (typeof b.slash === 'string') {
    const s = b.slash.replace(/^\//, '').toLowerCase();
    if (!/^[a-z0-9-]+$/.test(s)) return null;
    out.slash = s;
  } else if (typeof b.prompt === 'string' && b.prompt) {
    out.prompt = b.prompt;
  } else if (typeof b.url === 'string' && /^https?:\/\//.test(b.url)) out.url = b.url;
  else if (Array.isArray(b.run) && b.run.length && b.run.every(a => typeof a === 'string')) {
    out.run = b.run;
  } else return null;
  if (typeof b.group === 'string' && b.group) out.group = clip(b.group, 24);
  return out;
}

// Normalize the band toggle: unusable parts fall back to the defaults.
function normalizeToggle(t) {
  const out = defaultToggle();
  if (!t || typeof t !== 'object') return out;
  if (typeof t.label === 'string' && t.label) out.label = clip(t.label, 6);
  if (typeof t.hotkey === 'string' && /^[0-9a-z]$/.test(t.hotkey)) out.hotkey = t.hotkey;
  return out;
}

// Parse config text into module state. Pure (no $ nouns) so session.start's
// loader and the /ccsl-buttons reload share it. Throws on bad JSON — callers
// wrap in safe(), which leaves the previous state standing.
function applyConfigText(text) {
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed.buttons)
    ? parsed.buttons.map(normalizeButton).filter(Boolean)
    : [];
  buttons = list.length ? list : defaultButtons();
  toggle = normalizeToggle(parsed.toggle);
  if (typeof parsed.contextWindow === 'number' && parsed.contextWindow > 0) {
    ctxWindow = parsed.contextWindow;
  }
  return buttons.length;
}

// Which launcher section a button lands in: slash/pane → quick switches, the
// rest by action type, a custom group naming its own section.
function sectionKey(b) {
  if (b.group) return b.group;
  if (b.slash || b.pane) return 'quick';
  if (typeof b.prompt === 'string') return 'prompt';
  if (b.url) return 'url';
  return 'run';
}

// Section order: the four built-ins in fixed order, custom groups after, in
// first-appearance order. Header color carries the section's identity.
const SECTION_STYLES = new Map([
  ['quick', { title: '⚡ 快捷切换', color: 'yellow' }],
  ['prompt', { title: '✏ 提示词', color: 'cyan' }],
  ['url', { title: '🔗 链接', color: 'blue' }],
  ['run', { title: '$ 命令', color: 'green' }],
]);
function sectionModel() {
  const list = buttons || defaultButtons();
  const keys = [...SECTION_STYLES.keys()].filter(k => list.some(b => sectionKey(b) === k));
  const custom = [];
  for (const b of list) {
    const k = sectionKey(b);
    if (b.group && !custom.includes(k)) custom.push(k);
  }
  return [...keys, ...custom].map(key => ({
    key,
    style: SECTION_STYLES.get(key) || { title: `◆ ${key}`, color: 'gray' },
    items: list.filter(b => sectionKey(b) === key),
  }));
}

// Quick switches and prompts lay out two per row; links and commands one per
// line. Pairs keep the launcher short enough to scan whole.
function pairRows(items) {
  const rows = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return rows;
}
const TWO_COLUMN = new Set(['quick', 'prompt']);

// A bookmark-style address: no protocol, capped.
function displayUrl(url) {
  const bare = url.replace(/^https?:\/\//, '');
  return bare.length > 42 ? clip(bare, 41) + '…' : bare;
}

// The argv a run button will execute, shown beside its label.
function displayRun(argv) {
  const s = argv.join(' ');
  return s.length > 36 ? clip(s, 35) + '…' : s;
}

function browserArgv(url) {
  if (process.platform === 'win32') return ['cmd', '/c', 'start', '', url];
  if (process.platform === 'darwin') return ['open', url];
  return ['xdg-open', url];
}

// Content height the pane wants: headers + rows (two-column sections count
// pairs), an inline run result, the hint line, a line of slack.
function launcherRows() {
  const secs = sectionModel();
  let n = 0;
  for (const s of secs) {
    n += 3; // header + the card's two border rows
    n += TWO_COLUMN.has(s.key) ? Math.ceil(s.items.length / 2) : s.items.length;
  }
  if (secs.some(s => s.key === 'run') && lastRun) n += 1;
  return Math.max(6, Math.min(34, n + 1));
}

export function register(on) {
  // session.start fires on load AND on every hot reload of this module.
  on('session.start', async ($, e, next) => {
    await safe(async () => {
      const saved = await $.store.get('usage-history');
      if (Array.isArray(saved)) history = saved.filter(r => r && typeof r.out === 'number');
      const savedCost = await $.store.get('usage-cost-total');
      if (typeof savedCost === 'number') costAll = savedCost;
    }, null);
    // The pricing table the status line and pricing-updater maintain; without
    // it the cost line just says so (tokens still count).
    await safe(async () => {
      const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'));
      if (!home) return;
      const txt = await $.fs.read(`${home}/.claude/pricing.json`.replace(/\\/g, '/'));
      const p = JSON.parse(txt);
      if (p && typeof p === 'object') pricing = p;
    }, null);
    // Load button config, creating the file with a working engineering
    // template when it doesn't exist yet so customizing is just "edit this
    // file".
    await safe(async () => {
      const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'));
      if (!home) return;
      const cfgPath = `${home}/.claude/ccsl-buttons.json`.replace(/\\/g, '/');
      const text = await safe(async () => await $.fs.read(cfgPath), null);
      if (text === null) {
        await $.fs.write(cfgPath, configTemplate());
        applyConfigText(configTemplate());
      } else {
        const up = templateUpgrade(text);
        if (up) {
          // Untouched legacy factory file — refresh it in place so upgrades
          // actually reach the person (an edited file never matches and is
          // always preserved).
          await $.fs.write(cfgPath, up);
          const n = applyConfigText(up);
          $.ui.toast(`ccsl: 未修改的旧按钮模板已自动升级（${n} 个按钮）`);
        } else {
          applyConfigText(text);
        }
      }
    }, null);
    for (const cmd of [
      { name: 'ccsl-usage', description: 'Token usage stats + sparkline (cc-statusline mod)' },
      { name: 'ccsl-buttons', description: 'Reload ~/.claude/ccsl-buttons.json button config' },
    ]) {
      await safe(async () => {
        await $.command.register(cmd);
      }, null);
    }
    return next(e);
  });

  // Every model request reports its usage here — the data source the status
  // line has to parse transcripts for, handed to us directly. turn.step is a
  // STREAMING event: yield the chunks next() produces through untouched, take
  // the return value, record usage from whichever shape carried it.
  on('turn.step', async function* ($, e, next) {
    let result;
    const n = next(e);
    if (n && typeof n[Symbol.asyncIterator] === 'function') {
      result = yield* n; // delegate: pass every chunk through, take the return
    } else {
      result = await n;
    }
    try {
      const rec = usageFrom(e) || usageFrom(result);
      if (rec) {
        // Cost rides the record when the pricing table knows the model
        // (e.model is the engine's resolved name for this step); in+cacheR
        // approximates the context the request sat in.
        const rates = resolvePricing(e.model, pricing);
        if (rates) rec.cost = computeCost(rec, rates);
        rec.ctx = rec.in + rec.cacheR;
        history.push(rec);
        if (history.length > MAX_POINTS) history = history.slice(-MAX_POINTS);
        if (rec.cost) {
          costAll += rec.cost;
          await safe(async () => {
            await $.store.set('usage-cost-total', costAll);
          }, null);
        }
        // Context-budget alert: one toast per threshold per fill cycle; a
        // drop back under 70% (a compact, a new session) re-arms them.
        const ratio = rec.ctx / ctxWindow;
        if (ratio >= 0.9 && warnedCtx < 0.9) {
          warnedCtx = 0.9;
          $.ui.toast(`ccsl: 上下文已用 ${Math.round(ratio * 100)}% — 建议 /compact 压缩`);
        } else if (ratio >= 0.8 && warnedCtx < 0.8) {
          warnedCtx = 0.8;
          $.ui.toast(`ccsl: 上下文已用 ${Math.round(ratio * 100)}%`);
        }
        if (ratio < 0.7) warnedCtx = 0;
        await safe(async () => {
          await $.ui.invalidate('ui.render');
        }, null);
      }
    } catch {
      /* recording must never break the stream */
    }
    return result;
  });

  // /ccsl-usage — instant command, zero model turns, works while Claude runs.
  on('command.run', { command: 'ccsl-usage' }, async ($, e) => {
    await safe(async () => {
      await $.ui.open({ id: PANE, title: 'Usage', focus: true, closeOnEscape: true });
    }, null);
    return { text: 'cc-statusline: opening the usage pane (Esc closes it; /ccsl-usage reopens).' };
  }).catch(() => {});

  // /ccsl-buttons — reload the config file after editing it.
  on('command.run', { command: 'ccsl-buttons' }, async ($, e) => {
    let msg = 'cc-statusline: could not load the config.';
    await safe(async () => {
      const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'));
      const cfgPath = `${home}/.claude/ccsl-buttons.json`.replace(/\\/g, '/');
      const text = await $.fs.read(cfgPath);
      const up = templateUpgrade(text);
      if (up) {
        await $.fs.write(cfgPath, up);
        msg = `cc-statusline: legacy template upgraded — ${applyConfigText(up)} button(s) from ${cfgPath}.`;
      } else {
        msg = `cc-statusline: loaded ${applyConfigText(text)} button(s) from ${cfgPath}.`;
      }
    }, null);
    return { text: msg };
  }).catch(() => {});

  // The launcher's sections as element trees — shared shape by the pane and
  // the band fallback. The press factory is handed in from the hook that
  // bound $ (helpers never receive $ nouns); this layer only lays out.
  // Each section is a CARD: rounded border in the section color, colored
  // bold header inside, then the buttons — two aligned columns for quick and
  // prompts (fixed-width cells, wrapping below ~44 cols), one per line for
  // links and commands with the target shown dim beside the label (bookmark
  // address / the actual argv). No emoji in button labels: terminals render
  // them at inconsistent widths and they collide with the text. The finished
  // command's result line is colored by exit code — green done, red failed.
  function sectionEls(ui, pressButton, keyPrefix, cols) {
    return sectionModel().map((s, si) => {
      const kids = [
        ui.Text({
          key: `${keyPrefix}-h-${s.key}`,
          color: s.style.color,
          bold: true,
          children: s.style.title,
        }),
      ];
      const buttonEl = b => {
        const common = {
          key: `ccsl-btn-${b.hotkey || b.label}`,
          hotkey: b.hotkey,
          plain: true,
          onPress: pressButton(b),
        };
        const detail = b.url ? displayUrl(b.url) : Array.isArray(b.run) ? displayRun(b.run) : null;
        return detail
          ? ui.Button({
              ...common,
              children: [
                b.label,
                ui.Text({ key: `ccsl-det-${common.key}`, dimColor: true, children: `  ${detail}` }),
              ],
            })
          : ui.Button({ ...common, label: b.label });
      };
      if (TWO_COLUMN.has(s.key)) {
        for (const [ri, row] of pairRows(s.items).entries()) {
          kids.push(
            ui.Box({
              key: `${keyPrefix}-row-${s.key}-${ri}`,
              flexDirection: 'row',
              flexWrap: 'wrap',
              children: row.map((b, i) =>
                ui.Box({
                  key: `${keyPrefix}-cell-${s.key}-${ri}-${i}`,
                  width: 20,
                  marginRight: i ? 0 : 2,
                  children: [buttonEl(b)],
                })
              ),
            })
          );
        }
      } else {
        for (const b of s.items) kids.push(buttonEl(b));
      }
      if (s.key === 'run' && lastRun) {
        kids.push(
          ui.Text({
            key: `${keyPrefix}-lastrun`,
            color: lastRun.exitCode === 0 ? 'green' : 'red',
            children: `↳ ${lastRun.label}: exit ${lastRun.exitCode}${lastRun.tail ? ` · ${lastRun.tail}` : ''}`,
          })
        );
      }
      // Uniform card width (the body's own width, capped) with content
      // centered: every card aligns edge to edge and every row sits symmetric
      // about the pane's axis — ragged auto-width cards read as sloppy.
      return ui.Box({
        key: `${keyPrefix}-sec-${s.key}`,
        borderStyle: 'round',
        borderColor: s.style.color,
        flexDirection: 'column',
        alignItems: 'center',
        width: cols ? Math.min(cols, 48) : undefined,
        paddingX: 1,
        marginTop: si ? 1 : 0,
        children: kids,
      });
    });
  }

  // The launcher pane: every section in one view + hint. Answering (no next)
  // means we own this body entirely.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== BUTTONS_PANE) return next(e);
    const ui = await safe(async () => $.ui.resolve(e), null);
    if (!ui || !ui.Box || !ui.Button || !ui.Text) return next(e);
    const pressButton = b => () => {
      // Dispatch by action type. Every $ call happens right here (the
      // $-noun discipline), and every path toasts — silent failures were
      // how dead buttons stayed undiagnosable.
      try {
        if (b.url) {
          $.ui.toast(`opening ${b.url}`);
          $.process
            .run(browserArgv(b.url))
            .then(() => {})
            .catch(err => $.ui.toast(`ccsl: ${err && err.message}`));
        } else if (typeof b.slash === 'string' || typeof b.prompt === 'string') {
          // Fill the composer and let the person press Enter — nothing runs
          // without confirmation (and a plugin's prompt.submit can't run
          // interactive commands like /model at all: it queues a turn of its
          // own instead). Collapse whichever launcher form is up first
          // (inlined — $ nouns never reach helpers).
          if (inlineUp) {
            inlineUp = false;
            $.ui.invalidate('ui.render');
          }
          if (paneUp) {
            paneUp = false;
            $.ui.close({ id: BUTTONS_PANE }).catch(err => $.ui.toast(`ccsl: ${err && err.message}`));
          }
          const text = typeof b.slash === 'string' ? `/${b.slash}` : b.prompt;
          $.prompt
            .fill({ text, mode: 'insert' })
            .then(r => {
              if (r && r.isFilled === false) {
                $.ui.toast(`ccsl: 无法填入${r.refusal === 'dialog' ? '（对话框占用）' : r.refusal === 'no_composer' ? '（无可用的输入框）' : ''}`);
              } else {
                $.ui.toast('已填入 — Enter 执行');
              }
            })
            .catch(err => $.ui.toast(`ccsl: ${err && err.message}`));
        } else if (Array.isArray(b.run)) {
          $.ui.toast(`${b.label}: running…`);
          $.process
            .run(b.run, { timeoutMs: 600000 })
            .then(r => {
              const tail = ((r.stdout || '') + (r.stderr || '')).trim().slice(-160);
              lastRun = { label: b.label, exitCode: r.exitCode, tail };
              $.ui.invalidate('ui.render');
              $.ui.toast(`${b.label}: exit ${r.exitCode}`);
            })
            .catch(err => {
              lastRun = { label: b.label, exitCode: '?', tail: err && err.message };
              $.ui.invalidate('ui.render');
              $.ui.toast(`${b.label}: ${err && err.message}`);
            });
        } else {
          const paneId = b.pane || PANE;
          $.ui
            .open({ id: paneId, title: 'Usage', focus: true, closeOnEscape: true })
            .then(() => $.ui.toast(`${b.label}: opened`))
            .catch(err => $.ui.toast(`ccsl: ${err && err.message}`));
        }
      } catch (err) {
        $.ui.toast(`ccsl: ${err && err.message}`);
      }
    };
    const kids = sectionEls(ui, pressButton, 'ccsl-pane', e.props && e.props.bodyColumns);
    kids.push(
      ui.Text({
        key: 'ccsl-btns-hint',
        dimColor: true,
        children: '编辑 ~/.claude/ccsl-buttons.json · /ccsl-buttons 重载 · Esc 关闭',
      })
    );
    return ui.Box({ key: 'ccsl-buttons-pane', flexDirection: 'column', children: kids });
  });

  // Quick-action band above the prompt: ONE toggle button that opens and
  // closes the launcher. The open/close must leave this press dispatch
  // synchronously — the engine credits a pane open to the person's press
  // only then; anything after an await counts as the plugin acting alone and
  // waits undrawn below 144 columns. So the toggle branches on tracked state
  // and reads the open() result afterwards for the inline fallback. A draw
  // site is answered with a tree: compose ours UNDER whatever the rest of
  // the chain drew, and yield entirely while a survey holds the band.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props && e.props.hasSurvey) return next(e);
    const ui = await safe(async () => $.ui.resolve(e), null);
    if (!ui || !ui.Box || !ui.Button || !ui.Text) return next(e);
    // Re-sync with the engine's record (Esc closes, reloads, wider terms).
    const panes = await safe(async () => await $.ui.panes(), null);
    if (panes) paneUp = panes.some(p => p.id === BUTTONS_PANE && p.isPlaced !== false);
    const t = toggle || defaultToggle();
    const toggleBtn = ui.Button({
      key: 'ccsl-toggle',
      label: t.label,
      hotkey: t.hotkey,
      variant: 'primary',
      onPress: () => {
        // Synchronous dispatch — no await before open/close, ever.
        try {
          if (paneUp) {
            paneUp = false;
            $.ui.close({ id: BUTTONS_PANE }).catch(err => $.ui.toast(`ccsl: ${err && err.message}`));
          } else if (inlineUp) {
            inlineUp = false;
            $.ui.invalidate('ui.render');
          } else {
            paneUp = true;
            $.ui
              .open({
                id: BUTTONS_PANE,
                title: '✳ 启动器',
                focus: true,
                closeOnEscape: true,
                rows: launcherRows(),
              })
              .then(r => {
                if (r && r.isPlaced === false) {
                  paneUp = false;
                  inlineUp = true;
                  $.ui.toast(`ccsl: 面板暂不摆放 (${r && r.reason}) — 已在带内展开`);
                  $.ui.invalidate('ui.render');
                }
              })
              .catch(err => {
                paneUp = false;
                $.ui.toast(`ccsl: ${err && err.message}`);
              });
          }
        } catch (err) {
          paneUp = false;
          $.ui.toast(`ccsl: ${err && err.message}`);
        }
      },
    });
    // The toggle stays at the LEFT of the band; while a model turn runs, a
    // dim marker beside it says so (e.props.isWorking is the engine's word).
    const rowKids = [toggleBtn];
    if (e.props && e.props.isWorking) {
      rowKids.push(ui.Text({ key: 'ccsl-working', dimColor: true, children: ' · 运行中' }));
    }
    const kids = [
      ui.Box({
        key: 'ccsl-band-row',
        flexDirection: 'row',
        children: rowKids,
      }),
    ];
    if (inlineUp) {
      // The inline fallback mirrors the pane's launcher — same sections, same
      // dispatch, duplicated here because the press factory must bind this
      // hook's $ (helpers never receive $ nouns).
      const pressButton = b => () => {
        try {
          if (b.url) {
            $.ui.toast(`opening ${b.url}`);
            $.process
              .run(browserArgv(b.url))
              .then(() => {})
              .catch(err => $.ui.toast(`ccsl: ${err && err.message}`));
          } else if (typeof b.slash === 'string' || typeof b.prompt === 'string') {
            if (inlineUp) {
              inlineUp = false;
              $.ui.invalidate('ui.render');
            }
            if (paneUp) {
              paneUp = false;
              $.ui.close({ id: BUTTONS_PANE }).catch(err => $.ui.toast(`ccsl: ${err && err.message}`));
            }
            const text = typeof b.slash === 'string' ? `/${b.slash}` : b.prompt;
            $.prompt
              .fill({ text, mode: 'insert' })
              .then(r => {
                if (r && r.isFilled === false) {
                  $.ui.toast(`ccsl: 无法填入${r.refusal === 'dialog' ? '（对话框占用）' : r.refusal === 'no_composer' ? '（无可用的输入框）' : ''}`);
                } else {
                  $.ui.toast('已填入 — Enter 执行');
                }
              })
              .catch(err => $.ui.toast(`ccsl: ${err && err.message}`));
          } else if (Array.isArray(b.run)) {
            $.ui.toast(`${b.label}: running…`);
            $.process
              .run(b.run, { timeoutMs: 600000 })
              .then(r => {
                const tail = ((r.stdout || '') + (r.stderr || '')).trim().slice(-160);
                lastRun = { label: b.label, exitCode: r.exitCode, tail };
                $.ui.invalidate('ui.render');
                $.ui.toast(`${b.label}: exit ${r.exitCode}`);
              })
              .catch(err => {
                lastRun = { label: b.label, exitCode: '?', tail: err && err.message };
                $.ui.invalidate('ui.render');
                $.ui.toast(`${b.label}: ${err && err.message}`);
              });
          } else {
            const paneId = b.pane || PANE;
            $.ui
              .open({ id: paneId, title: 'Usage', focus: true, closeOnEscape: true })
              .then(() => $.ui.toast(`${b.label}: opened`))
              .catch(err => $.ui.toast(`ccsl: ${err && err.message}`));
          }
        } catch (err) {
          $.ui.toast(`ccsl: ${err && err.message}`);
        }
      };
      sectionEls(ui, pressButton, 'ccsl-inline', e.props && e.props.bodyColumns).forEach(k => kids.push(k));
      kids.push(ui.Text({ key: 'ccsl-inline-hint', dimColor: true, children: '再按一次 ✳ 收起' }));
    }
    const band = ui.Box({ key: 'ccsl-band', flexDirection: 'column', children: kids });
    const inner = await safe(() => next(e), null);
    if (inner && typeof inner === 'object') {
      return ui.Box({
        key: 'ccsl-band-wrap',
        flexDirection: 'column',
        children: [inner, band],
      });
    }
    return band;
  });

  // The usage pane: sparkline of per-request output tokens + colored
  // cumulative totals. Answering (no next) means we own this body entirely.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const ui = await safe(async () => $.ui.resolve(e), null);
    if (!ui || !ui.Box || !ui.Text) return next(e);
    // Self-heal: if session.start's restore failed (or landed after this
    // draw), pull the persisted history right here — the pane never lies about
    // having no data while the store holds some.
    if (!history.length) {
      await safe(async () => {
        const saved = await $.store.get('usage-history');
        if (Array.isArray(saved)) history = saved.filter(r => r && typeof r.out === 'number');
      }, null);
    }
    const t = totals();
    const recent = history.slice(-60);
    const bars = spark(recent.map(r => r.out));
    const last = history[history.length - 1];
    const ctxTxt = last && last.ctx
      ? `ctx ${fmt(last.ctx)}/${fmt(ctxWindow)} (${Math.min(99, Math.round((last.ctx / ctxWindow) * 100))}%)`
      : null;
    return ui.Box({
      key: 'ccsl-pane',
      flexDirection: 'column',
      children: [
        ui.Text({
          key: 'ccsl-spark',
          color: 'cyan',
          children: bars ? `out/request ${bars}` : 'no usage recorded yet — run a prompt first',
        }),
        ui.Box({
          key: 'ccsl-totals',
          flexDirection: 'row',
          children: [
            ui.Text({ key: 'ccsl-tot-req', dimColor: true, children: `requests ${history.length}   ` }),
            ui.Text({ key: 'ccsl-tot-out', color: 'cyan', children: `out ${fmt(t.out)}   ` }),
            ui.Text({ key: 'ccsl-tot-in', color: 'green', children: `in ${fmt(t.in)}   ` }),
            ui.Text({ key: 'ccsl-tot-cr', color: 'magenta', children: `cacheR ${fmt(t.cacheR)}   ` }),
            ui.Text({ key: 'ccsl-tot-cw', color: 'yellow', children: `cacheW ${fmt(t.cacheW)}` }),
          ],
        }),
        ui.Text({
          key: 'ccsl-cost',
          color: 'yellow',
          children: pricing
            ? `cost $${t.cost.toFixed(2)} 会话 · $${costAll.toFixed(2)} 累计`
            : 'cost — 无定价表（~/.claude/pricing.json，跑一次 pricing-updater 生成）',
        }),
        ...(ctxTxt
          ? [ui.Text({ key: 'ccsl-ctx', dimColor: true, children: ctxTxt })]
          : []),
        ui.Text({ key: 'ccsl-hint', dimColor: true, children: 'Esc closes · /ccsl-usage reopens' }),
      ],
    });
  });
}
