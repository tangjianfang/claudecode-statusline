// cc-statusline companion mod — quick actions + per-request usage stats.
//
// Runs INSIDE Claude Code (a plugin "mod"), unlike statusline.js which is a
// subprocess. That buys two things the status line can't do:
//   * a single toggle button above the prompt (the AbovePrompt band) that
//     opens a tabbed launcher of quick-action buttons, each with its hotkey,
//   * direct sight of every model request via `turn.step`, so usage stats
//     arrive with zero transcript parsing.
//
// The launcher is TABBED: a row of tab markers on top, one tab's buttons in
// the body (`hotkey: label`, one plain button per line — the survey idiom).
// The default tab is 快捷 (quick switches); the others open on click. Tabs
// map to action types: slash/pane → 快捷, prompt → 提示词, url → 链接 (drawn
// bookmark-style: alias + dim address), run → 命令 (result rendered inline
// below the buttons once it lands); "group" names a custom tab. If the engine
// won't place the pane (opens outside the person's press dispatch wait
// undrawn below 144 columns; open() then answers { isPlaced: false, reason }),
// the same tab bar + current tab expand INLINE in the band — reachable at any
// width, the engine's reason toasted rather than swallowed.
//
// Custom buttons: ~/.claude/ccsl-buttons.json (auto-created with examples on
// first load; /ccsl-buttons reloads it). The band carries only the toggle
// (restyled via "toggle"). Each button is one of:
//   { label, hotkey, pane:   "ccsl-usage" }                  open a mod pane
//   { label, hotkey, slash:  "fast" }        submit "/fast" (a mode switch —
//                                            permissions opens CC's dialog, the
//                                            API has no mode setter yet)
//   { label, hotkey, prompt: "text", submit: false }         fill the prompt
//   { label, hotkey, prompt: "text", submit: true }          send immediately
//   { label, hotkey, url:    "https://..." }                 open in browser
//   { label, hotkey, run:    ["npm", "test"] }               host command
//   { label, hotkey, ..., group: "name" }                    own tab
// Slash and prompt buttons close the launcher first — a picked action means
// back to the conversation; the other kinds keep it open.
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

// Per-request usage records: [{ ts, out, in, cacheR, cacheW }]
let history = [];

// Loaded button config (module state; session.start + /ccsl-buttons load it).
let buttons = null;
let toggle = null;

// Launcher visibility. paneUp tracks the engine's pane (refreshed from
// $.ui.panes() at every band draw, set by our own open/close); inlineUp is
// the band-embedded fallback used when the engine won't place the pane.
let paneUp = false;
let inlineUp = false;

// Which launcher tab is open (null = the first); null-safe on reloads.
let activeTab = null;

// Last finished host command, rendered inline under the 命令 tab.
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
    }),
    { out: 0, in: 0, cacheR: 0, cacheW: 0 }
  );
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

// The default buttons, used until a config file exists (and as part of the
// template the auto-created ~/.claude/ccsl-buttons.json ships with).
function defaultButtons() {
  return [
    { label: 'usage', hotkey: 'u', pane: PANE },
    { label: '快速模式', hotkey: 'f', slash: 'fast' },
    { label: '权限设置', hotkey: 'p', slash: 'permissions' },
  ];
}

// The band's one toggle button — the launcher stays one keypress away even
// with everything else customized away.
function defaultToggle() {
  return { label: '☰', hotkey: 'm' };
}

function configTemplate() {
  return `${JSON.stringify(
    {
      _doc: 'cc-statusline mod buttons. The band shows one toggle; it opens the tabbed launcher. Actions: pane=<pane id> | slash=<command> (submits /<command>; permissions opens CC dialog — no mode setter API yet) | prompt=<text> (+submit:true to send at once) | url=<https://...> | run=[argv]. Tabs by type: slash/pane=快捷 prompt=提示词 url=链接 run=命令; group=<name> gives a button its own tab. toggle restyles the band button. hotkey: one digit/lowercase letter, works while the site (band or pane) holds focus. Reload with /ccsl-buttons.',
      toggle: { label: '☰', hotkey: 'm' },
      buttons: [
        { label: 'usage', hotkey: 'u', pane: PANE },
        { label: '快速模式', hotkey: 'f', slash: 'fast' },
        { label: '权限设置', hotkey: 'p', slash: 'permissions' },
        { label: '测试并修复', hotkey: 't', prompt: 'Run the full test suite and fix any failures.', submit: true },
        { label: '审查改动', hotkey: 'r', prompt: 'Review the current diff for correctness bugs and suggest fixes.' },
        { label: '解释代码', hotkey: 'e', prompt: 'Explain the key parts of this codebase.' },
        { label: '继续任务', hotkey: 'n', prompt: 'Continue the previous task.', submit: true },
        { label: '仓库', hotkey: 'o', url: 'https://github.com/tangjianfang/claudecode-statusline' },
        { label: '议题', hotkey: 'i', url: 'https://github.com/tangjianfang/claudecode-statusline/issues' },
        { label: '语法检查', hotkey: 'k', run: ['npm', 'run', 'check'] },
        { label: '更新价格', hotkey: 'j', run: ['npm', 'run', 'update-pricing'] },
        { label: '其他命令', hotkey: 'x', group: 'misc', run: ['node', '--version'] },
      ],
    },
    null,
    2
  )}\n`;
}

// Normalize one config entry: label required, hotkey one digit/lowercase
// letter, exactly one action field, optional group. Returns null for junk.
function normalizeButton(b) {
  if (!b || typeof b.label !== 'string' || !b.label) return null;
  const out = { label: b.label.slice(0, 24) };
  if (typeof b.hotkey === 'string' && /^[0-9a-z]$/.test(b.hotkey)) out.hotkey = b.hotkey;
  if (typeof b.pane === 'string' && b.pane) out.pane = b.pane;
  else if (typeof b.slash === 'string') {
    const s = b.slash.replace(/^\//, '').toLowerCase();
    if (!/^[a-z0-9-]+$/.test(s)) return null;
    out.slash = s;
  } else if (typeof b.prompt === 'string' && b.prompt) {
    out.prompt = b.prompt;
    out.submit = b.submit === true;
  } else if (typeof b.url === 'string' && /^https?:\/\//.test(b.url)) out.url = b.url;
  else if (Array.isArray(b.run) && b.run.length && b.run.every(a => typeof a === 'string')) {
    out.run = b.run;
  } else return null;
  if (typeof b.group === 'string' && b.group) out.group = b.group.slice(0, 24);
  return out;
}

// Normalize the band toggle: unusable parts fall back to the defaults.
function normalizeToggle(t) {
  const out = defaultToggle();
  if (!t || typeof t !== 'object') return out;
  if (typeof t.label === 'string' && t.label) out.label = t.label.slice(0, 6);
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
  activeTab = null; // re-resolve against the new tabs
  return buttons.length;
}

// Which launcher tab a button lands in: slash/pane → quick switches, the
// rest by action type, a custom group naming its own tab.
function tabKey(b) {
  if (b.group) return b.group;
  if (b.slash || b.pane) return 'quick';
  if (typeof b.prompt === 'string') return 'prompt';
  if (b.url) return 'url';
  return 'run';
}

// Tab order: the four built-ins in fixed order, custom groups after, in
// first-appearance order.
const TAB_TITLES = new Map([
  ['quick', '快捷'],
  ['prompt', '提示词'],
  ['url', '链接'],
  ['run', '命令'],
]);
function tabModel() {
  const list = buttons || defaultButtons();
  const builtins = [...TAB_TITLES.keys()].filter(k => list.some(b => tabKey(b) === k));
  const custom = [];
  for (const b of list) {
    const k = tabKey(b);
    if (b.group && !custom.includes(k)) custom.push(k);
  }
  return [...builtins, ...custom].map(key => ({
    key,
    title: TAB_TITLES.get(key) || `◆ ${key}`,
    items: list.filter(b => tabKey(b) === key),
  }));
}

function currentTab() {
  const tabs = tabModel();
  return tabs.find(t => t.key === activeTab) || tabs[0];
}

// A bookmark-style address: no protocol, capped.
function displayUrl(url) {
  const bare = url.replace(/^https?:\/\//, '');
  return bare.length > 42 ? bare.slice(0, 41) + '…' : bare;
}

function browserArgv(url) {
  if (process.platform === 'win32') return ['cmd', '/c', 'start', '', url];
  if (process.platform === 'darwin') return ['open', url];
  return ['xdg-open', url];
}

// Content height the pane wants: tab row + the open tab's buttons, an inline
// run result, the hint line, a line of slack.
function launcherRows() {
  const tab = currentTab();
  const n = 1 + tab.items.length + (tab.key === 'run' && lastRun ? 1 : 0) + 1;
  return Math.max(6, Math.min(30, n + 1));
}

export function register(on) {
  // session.start fires on load AND on every hot reload of this module.
  on('session.start', async ($, e, next) => {
    await safe(async () => {
      const saved = await $.store.get('usage-history');
      if (Array.isArray(saved)) history = saved.filter(r => r && typeof r.out === 'number');
    }, null);
    // Load button config, creating the file with a documented template when
    // it doesn't exist yet so customizing is just "edit this file".
    await safe(async () => {
      const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'));
      if (!home) return;
      const cfgPath = `${home}/.claude/ccsl-buttons.json`.replace(/\\/g, '/');
      const text = await safe(async () => await $.fs.read(cfgPath), null);
      if (text === null) {
        await $.fs.write(cfgPath, configTemplate());
        applyConfigText(configTemplate());
      } else {
        applyConfigText(text);
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
        history.push(rec);
        if (history.length > MAX_POINTS) history = history.slice(-MAX_POINTS);
        await safe(async () => {
          await $.store.set('usage-history', history.slice(-MAX_POINTS));
        }, null);
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
      const n = applyConfigText(await $.fs.read(cfgPath));
      msg = `cc-statusline: loaded ${n} button(s) from ${cfgPath}.`;
    }, null);
    return { text: msg };
  }).catch(() => {});

  // The launcher body (tab bar + the open tab), shared shape by the pane and
  // the band fallback. The press factory lives INSIDE each hook so every $
  // call stays lexically in the handler that bound $; this helper only lays
  // out what it's handed ($ nouns never reach it).
  function launcherKids(ui, pressTab, pressButton, keyPrefix) {
    const tabs = tabModel();
    const cur = currentTab();
    const kids = [
      ui.Box({
        key: `${keyPrefix}-tabs`,
        flexDirection: 'row',
        children: tabs.flatMap((t, i) => {
          const parts = t.key === cur.key
            ? [ui.Text({ key: `${keyPrefix}-tabcur-${t.key}`, children: '▸ ' })]
            : i
              ? [ui.Text({ key: `${keyPrefix}-tabgap-${i}`, dimColor: true, children: '  ' })]
              : [];
          parts.push(
            ui.Button({
              key: `ccsl-tab-${t.key}`,
              label: t.title,
              dimColor: t.key !== cur.key,
              plain: true,
              onPress: () => pressTab(t.key),
            })
          );
          return parts;
        }),
      }),
    ];
    for (const b of cur.items) {
      const common = {
        key: `ccsl-btn-${b.hotkey || b.label}`,
        hotkey: b.hotkey,
        plain: true,
        onPress: pressButton(b),
      };
      kids.push(
        b.url
          ? ui.Button({
              ...common,
              children: [
                b.label,
                ui.Text({ key: `ccsl-url-${common.key}`, dimColor: true, children: `  ${displayUrl(b.url)}` }),
              ],
            })
          : ui.Button({ ...common, label: b.label })
      );
    }
    if (cur.key === 'run' && lastRun) {
      kids.push(
        ui.Text({
          key: `${keyPrefix}-lastrun`,
          dimColor: true,
          children: `${lastRun.label}: exit ${lastRun.exitCode}${lastRun.tail ? ` · ${lastRun.tail}` : ''}`,
        })
      );
    }
    return kids;
  }

  // The launcher pane: tab bar + the open tab + hint. Answering (no next)
  // means we own this body entirely.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== BUTTONS_PANE) return next(e);
    const ui = await safe(async () => $.ui.resolve(e), null);
    if (!ui || !ui.Box || !ui.Button || !ui.Text) return next(e);
    const pressTab = key => {
      activeTab = key;
      $.ui.invalidate('ui.render');
    };
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
        } else if (typeof b.slash === 'string') {
          // A mode switch means back to the conversation: collapse whichever
          // launcher form is up, then submit the command.
          if (inlineUp) {
            inlineUp = false;
            $.ui.invalidate('ui.render');
          }
          if (paneUp) {
            paneUp = false;
            $.ui.close({ id: BUTTONS_PANE }).catch(err => $.ui.toast(`ccsl: ${err && err.message}`));
          }
          $.prompt.submit({ text: `/${b.slash}` });
          $.ui.toast(`已提交 /${b.slash}`);
        } else if (typeof b.prompt === 'string') {
          if (inlineUp) {
            inlineUp = false;
            $.ui.invalidate('ui.render');
          }
          if (paneUp) {
            paneUp = false;
            $.ui.close({ id: BUTTONS_PANE }).catch(err => $.ui.toast(`ccsl: ${err && err.message}`));
          }
          if (b.submit) {
            $.prompt.submit({ text: b.prompt });
            $.ui.toast(`sent: ${b.prompt.slice(0, 60)}`);
          } else {
            $.prompt
              .fill({ text: b.prompt, mode: 'insert' })
              .then(() => $.ui.toast(`filled — Enter to send`))
              .catch(err => $.ui.toast(`ccsl: ${err && err.message}`));
          }
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
    const kids = launcherKids(ui, pressTab, pressButton, 'ccsl-pane');
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
                title: 'Buttons',
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
    const kids = [ui.Box({ key: 'ccsl-band-row', flexDirection: 'row', children: [toggleBtn] })];
    if (inlineUp) {
      // The inline fallback mirrors the pane's launcher — same tab bar, same
      // dispatch, duplicated here because the press factories must bind this
      // hook's $ (helpers never receive $ nouns).
      const pressTab = key => {
        activeTab = key;
        $.ui.invalidate('ui.render');
      };
      const pressButton = b => () => {
        try {
          if (b.url) {
            $.ui.toast(`opening ${b.url}`);
            $.process
              .run(browserArgv(b.url))
              .then(() => {})
              .catch(err => $.ui.toast(`ccsl: ${err && err.message}`));
          } else if (typeof b.slash === 'string') {
            if (inlineUp) {
              inlineUp = false;
              $.ui.invalidate('ui.render');
            }
            if (paneUp) {
              paneUp = false;
              $.ui.close({ id: BUTTONS_PANE }).catch(err => $.ui.toast(`ccsl: ${err && err.message}`));
            }
            $.prompt.submit({ text: `/${b.slash}` });
            $.ui.toast(`已提交 /${b.slash}`);
          } else if (typeof b.prompt === 'string') {
            if (inlineUp) {
              inlineUp = false;
              $.ui.invalidate('ui.render');
            }
            if (paneUp) {
              paneUp = false;
              $.ui.close({ id: BUTTONS_PANE }).catch(err => $.ui.toast(`ccsl: ${err && err.message}`));
            }
            if (b.submit) {
              $.prompt.submit({ text: b.prompt });
              $.ui.toast(`sent: ${b.prompt.slice(0, 60)}`);
            } else {
              $.prompt
                .fill({ text: b.prompt, mode: 'insert' })
                .then(() => $.ui.toast(`filled — Enter to send`))
                .catch(err => $.ui.toast(`ccsl: ${err && err.message}`));
            }
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
      launcherKids(ui, pressTab, pressButton, 'ccsl-inline').forEach(k => kids.push(k));
      kids.push(ui.Text({ key: 'ccsl-inline-hint', dimColor: true, children: '再按一次 ☰ 收起' }));
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
        ui.Text({ key: 'ccsl-hint', dimColor: true, children: 'Esc closes · /ccsl-usage reopens' }),
      ],
    });
  });
}
