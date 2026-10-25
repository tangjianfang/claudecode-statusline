// cc-statusline companion mod — quick actions + per-request usage stats.
//
// Runs INSIDE Claude Code (a plugin "mod"), unlike statusline.js which is a
// subprocess. That buys two things the status line can't do:
//   * buttons above the prompt (the AbovePrompt band) with hotkeys,
//   * direct sight of every model request via `turn.step`, so usage stats
//     arrive with zero transcript parsing.
//
// Custom buttons: ~/.claude/ccsl-buttons.json (auto-created with examples on
// first load; /ccsl-buttons reloads it). Each button is one of:
//   { label, hotkey, pane:   "ccsl-usage" }                  open a mod pane
//   { label, hotkey, prompt: "text", submit: false }         fill the prompt
//   { label, hotkey, prompt: "text", submit: true }          send immediately
//   { label, hotkey, url:    "https://..." }                 open in browser
//   { label, hotkey, run:    ["npm", "test"] }               host command
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
//   * every button action toasts — a silent failure is an undiagnosable one.
// Anything that fails here degrades to "not shown" and never breaks a turn.

const PANE = 'ccsl-usage';
const MAX_POINTS = 240;

// Per-request usage records: [{ ts, out, in, cacheR, cacheW }]
let history = [];

// Loaded button config (module state; session.start + /ccsl-buttons load it).
let buttons = null;

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

// The default band, used until a config file exists (and as the template the
// auto-created ~/.claude/ccsl-buttons.json ships with).
function defaultButtons() {
  return [
    { label: 'usage', hotkey: 'u', pane: PANE },
    { label: 'tokens', hotkey: 'c', pane: PANE },
  ];
}

function configTemplate() {
  return `${JSON.stringify(
    {
      _doc: 'cc-statusline mod buttons. Actions: pane=<pane id> | prompt=<text> (+submit:true to send at once) | url=<https://...> | run=[argv]. hotkey: one digit/lowercase letter, works while the band holds focus (ctrl+x). Reload with /ccsl-buttons.',
      buttons: [
        { label: 'usage', hotkey: 'u', pane: PANE },
        { label: 'tokens', hotkey: 'c', pane: PANE },
        { label: 'tests', hotkey: 't', prompt: 'Run the full test suite and fix any failures.', submit: false },
        { label: 'repo', hotkey: 'o', url: 'https://github.com/tangjianfang/claudecode-statusline' },
        { label: 'check', hotkey: 'k', run: ['npm', 'run', 'check'] },
      ],
    },
    null,
    2
  )}\n`;
}

// Normalize one config entry: label required, hotkey one digit/lowercase
// letter, exactly one action field. Returns null for junk entries.
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
  return out;
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
        buttons = defaultButtons();
      } else {
        const parsed = JSON.parse(text);
        const list = Array.isArray(parsed.buttons)
          ? parsed.buttons.map(normalizeButton).filter(Boolean)
          : [];
        buttons = list.length ? list : defaultButtons();
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
      const parsed = JSON.parse(await $.fs.read(cfgPath));
      const list = Array.isArray(parsed.buttons)
        ? parsed.buttons.map(normalizeButton).filter(Boolean)
        : [];
      buttons = list.length ? list : defaultButtons();
      msg = `cc-statusline: loaded ${buttons.length} button(s) from ${cfgPath}.`;
    }, null);
    return { text: msg };
  }).catch(() => {});

  // Quick-action band above the prompt: the configured buttons. A draw site
  // is answered with a tree: compose ours UNDER whatever the rest of the
  // chain drew (next(e) resolves to their tree), and yield entirely while a
  // survey holds the band — the props table says a hook yields to it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props && e.props.hasSurvey) return next(e);
    const ui = await safe(async () => $.ui.resolve(e), null);
    if (!ui || !ui.Box || !ui.Button || !ui.Text) return next(e);
    const t = totals();
    const list = buttons || defaultButtons();
    // Button labels: the two built-ins carry live totals; custom ones show
    // their configured label as-is.
    const parts = [];
    for (const b of list) {
      if (parts.length) parts.push(ui.Text({ key: `ccsl-sep-${parts.length}`, children: ' ' }));
      let label = b.label;
      if (b.pane === PANE) {
        if (b.hotkey === 'u') label = `usage ${fmt(t.out)}o`;
        else if (b.hotkey === 'c') label = `tokens ${fmt(t.in + t.out + t.cacheR + t.cacheW)}`;
      }
      parts.push(
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
    const band = ui.Box({ key: 'ccsl-band', flexDirection: 'row', children: parts });
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
