// cc-statusline companion mod — quick actions + per-request usage stats.
//
// Runs INSIDE Claude Code (a plugin "mod"), unlike statusline.js which is a
// subprocess. That buys two things the status line can't do:
//   * a single toggle button above the prompt (the AbovePrompt band) that
//     opens a pane of quick-action buttons, each with its own hotkey,
//   * direct sight of every model request via `turn.step`, so usage stats
//     arrive with zero transcript parsing.
//
// Custom buttons: ~/.claude/ccsl-buttons.json (auto-created with examples on
// first load; /ccsl-buttons reloads it). The band carries only the toggle
// (restyled via "toggle"); everything else lives in the buttons pane, its
// sections auto-grouped by action type — panes, prompts, links, commands —
// with an optional "group": "name" field moving a button to its own section.
// Each button is one of:
//   { label, hotkey, pane:   "ccsl-usage" }                  open a mod pane
//   { label, hotkey, prompt: "text", submit: false }         fill the prompt
//   { label, hotkey, prompt: "text", submit: true }          send immediately
//   { label, hotkey, url:    "https://..." }                 open in browser
//   { label, hotkey, run:    ["npm", "test"] }               host command
// Prompt buttons close the pane first — a picked prompt means back to the
// conversation; the other kinds keep it open.
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
//   * the band toggle reads the engine's own pane record ($.ui.panes()), not
//     module state — a person's Esc and a reload that leaves the pane up both
//     show up there.
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
    { label: 'tokens', hotkey: 'c', pane: PANE },
  ];
}

// The band's one toggle button — the pane stays one keypress away even with
// everything else customized away.
function defaultToggle() {
  return { label: '☰', hotkey: 'm' };
}

function configTemplate() {
  return `${JSON.stringify(
    {
      _doc: 'cc-statusline mod buttons. The band shows one toggle; it opens the buttons pane. Actions: pane=<pane id> | prompt=<text> (+submit:true to send at once) | url=<https://...> | run=[argv]. Optional group=<name> overrides the type section; toggle restyles the band button. hotkey: one digit/lowercase letter, works while the site (band or pane) holds focus. Reload with /ccsl-buttons.',
      toggle: { label: '☰', hotkey: 'm' },
      buttons: [
        { label: 'usage', hotkey: 'u', pane: PANE },
        { label: 'tokens', hotkey: 'c', pane: PANE },
        { label: '测试并修复', hotkey: 't', prompt: 'Run the full test suite and fix any failures.', submit: true },
        { label: '审查改动', hotkey: 'r', prompt: 'Review the current diff for correctness bugs and suggest fixes.' },
        { label: '解释代码', hotkey: 'e', prompt: 'Explain the key parts of this codebase.' },
        { label: '继续任务', hotkey: 'n', prompt: 'Continue the previous task.', submit: true },
        { label: '仓库', hotkey: 'o', url: 'https://github.com/tangjianfang/claudecode-statusline' },
        { label: '议题', hotkey: 'i', url: 'https://github.com/tangjianfang/claudecode-statusline/issues' },
        { label: '语法检查', hotkey: 'k', run: ['npm', 'run', 'check'] },
        { label: '更新价格', hotkey: 'p', run: ['npm', 'run', 'update-pricing'] },
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
  else if (typeof b.prompt === 'string' && b.prompt) {
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
  return buttons.length;
}

// Which pane section a button lands in: its action type, or its custom group.
function sectionKey(b) {
  if (b.group) return b.group;
  if (b.pane) return 'pane';
  if (typeof b.prompt === 'string') return 'prompt';
  if (b.url) return 'url';
  return 'run';
}

// Section order: the four action types in fixed order, custom groups after,
// in first-appearance order.
const SECTION_TITLES = new Map([
  ['pane', '⌨ 面板'],
  ['prompt', '✏ 提示词'],
  ['url', '🔗 链接'],
  ['run', '$ 命令'],
]);
function sectionOrder(list) {
  const kinds = [...SECTION_TITLES.keys()].filter(k => list.some(b => !b.group && sectionKey(b) === k));
  const custom = [];
  for (const b of list) if (b.group && !custom.includes(b.group)) custom.push(b.group);
  return [...kinds, ...custom];
}

function browserArgv(url) {
  if (process.platform === 'win32') return ['cmd', '/c', 'start', '', url];
  if (process.platform === 'darwin') return ['open', url];
  return ['xdg-open', url];
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

  // Quick-action band above the prompt: ONE toggle button that opens and
  // closes the buttons pane. A draw site is answered with a tree: compose
  // ours UNDER whatever the rest of the chain drew (next(e) resolves to their
  // tree), and yield entirely while a survey holds the band — the props table
  // says a hook yields to it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props && e.props.hasSurvey) return next(e);
    const ui = await safe(async () => $.ui.resolve(e), null);
    if (!ui || !ui.Box || !ui.Button) return next(e);
    const t = toggle || defaultToggle();
    const band = ui.Box({
      key: 'ccsl-band',
      flexDirection: 'row',
      children: [
        ui.Button({
          key: 'ccsl-toggle',
          label: t.label,
          hotkey: t.hotkey,
          onPress: () => {
            // Toggle by the engine's pane record — the person's Esc close and
            // a reload that left the pane up both live there, module state
            // would go stale. Every $ call happens right here ($-noun rule).
            try {
              $.ui
                .panes()
                .then(panes =>
                  panes.some(p => p.id === BUTTONS_PANE)
                    ? $.ui.close({ id: BUTTONS_PANE })
                    : $.ui.open({
                        id: BUTTONS_PANE,
                        title: 'Buttons',
                        focus: true,
                        closeOnEscape: true,
                      })
                )
                .catch(err => $.ui.toast(`ccsl: ${err && err.message}`));
            } catch (err) {
              $.ui.toast(`ccsl: ${err && err.message}`);
            }
          },
        }),
      ],
    });
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

  // The buttons pane: every configured quick action in typed sections (custom
  // groups after the four built-ins). Answering (no next) means we own this
  // body entirely.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== BUTTONS_PANE) return next(e);
    const ui = await safe(async () => $.ui.resolve(e), null);
    if (!ui || !ui.Box || !ui.Button || !ui.Text) return next(e);
    const t = totals();
    const list = buttons || defaultButtons();
    const order = sectionOrder(list);

    const sections = [];
    order.forEach((key, i) => {
      if (i) sections.push(ui.Text({ key: `ccsl-sec-gap-${i}`, children: ' ' }));
      const title = SECTION_TITLES.get(key) || `◆ ${key}`;
      const row = [];
      for (const b of list.filter(x => sectionKey(x) === key)) {
        if (row.length) row.push(ui.Text({ key: `ccsl-sec-sp-${key}-${row.length}`, children: ' ' }));
        // Button labels: the two built-ins carry live totals; a send-now
        // prompt says so; everything else shows its configured label as-is.
        let label = b.label;
        if (b.pane === PANE) {
          if (b.hotkey === 'u') label = `usage ${fmt(t.out)}o`;
          else if (b.hotkey === 'c') label = `tokens ${fmt(t.in + t.out + t.cacheR + t.cacheW)}`;
        } else if (typeof b.prompt === 'string' && b.submit) {
          label = `${b.label}(send)`;
        }
        row.push(
          ui.Button({
            key: `ccsl-btn-${b.hotkey || b.label}`,
            label,
            hotkey: b.hotkey,
            onPress: () => {
              // Dispatch by action type. Every $ call happens right here (the
              // $-noun discipline), and every path toasts — silent failures
              // were how dead buttons stayed undiagnosable.
              try {
                if (b.url) {
                  $.ui.toast(`opening ${b.url}`);
                  $.process
                    .run(browserArgv(b.url))
                    .then(() => {})
                    .catch(err => $.ui.toast(`ccsl: ${err && err.message}`));
                } else if (typeof b.prompt === 'string') {
                  // Picked a prompt → back to the conversation; the other
                  // kinds keep the pane open.
                  $.ui
                    .close({ id: BUTTONS_PANE })
                    .catch(err => $.ui.toast(`ccsl: ${err && err.message}`));
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
                      $.ui.toast(`${b.label}: exit ${r.exitCode}${tail ? ` · ${tail}` : ''}`);
                    })
                    .catch(err => $.ui.toast(`${b.label}: ${err && err.message}`));
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
            },
          })
        );
      }
      sections.push(
        ui.Box({
          key: `ccsl-sec-${key}`,
          flexDirection: 'column',
          children: [
            ui.Text({ key: `ccsl-sec-h-${key}`, dimColor: true, children: title }),
            ui.Box({ key: `ccsl-sec-row-${key}`, flexDirection: 'row', children: row }),
          ],
        })
      );
    });

    return ui.Box({
      key: 'ccsl-buttons-pane',
      flexDirection: 'column',
      children: [
        ...sections,
        ui.Text({
          key: 'ccsl-btns-hint',
          dimColor: true,
          children: '编辑 ~/.claude/ccsl-buttons.json · /ccsl-buttons 重载 · Esc 关闭',
        }),
      ],
    });
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
