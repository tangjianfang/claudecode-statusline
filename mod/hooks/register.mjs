// cc-statusline companion mod — quick actions + per-request usage stats.
//
// Runs INSIDE Claude Code (a plugin "mod"), unlike statusline.js which is a
// subprocess. That buys two things the status line can't do:
//   * buttons above the prompt (the AbovePrompt band) with hotkeys,
//   * direct sight of every model request via `turn.step`, so usage stats
//     arrive with zero transcript parsing.
//
// API discipline (learned from Claude Code's module validator + runtime):
//   * $ nouns ($.store, $.ui, $.command) must be CALLED, never read as values
//     or passed to helpers — call them where the handler bound them.
//   * streaming events (turn.step) take an async generator: yield* the chunks
//     through, record usage, return the result.
//   * draw sites (Pane body, AbovePrompt band) are ANSWERED: the hook returns
//     the element tree it wants drawn. next(e) resolves to what the rest of
//     the chain drew — wrap it to compose, never spread children onto the
//     event (the event has no children field; that draws nothing).
//   * command.run matches on { command: <name> }, answers with { text }, and
//     its registration needs a .catch (it's a gating event).
// Anything that fails here degrades to "not shown" and never breaks a turn.

const PANE = 'ccsl-usage';
const MAX_POINTS = 240;

// Per-request usage records: [{ ts, out, in, cacheR, cacheW }]
let history = [];

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

export function register(on) {
  // session.start fires on load AND on every hot reload of this module —
  // re-registering the same command name is fine, it replaces itself.
  on('session.start', async ($, e, next) => {
    await safe(async () => {
      const saved = await $.store.get('usage-history');
      if (Array.isArray(saved)) history = saved.filter(r => r && typeof r.out === 'number');
    }, null);
    await safe(async () => {
      await $.command.register({
        name: 'ccsl-usage',
        description: 'Token usage stats + sparkline (cc-statusline mod)',
      });
    }, null);
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

  // Quick-action band above the prompt: two hotkeyed buttons (u/c). A draw
  // site is answered with a tree: compose ours UNDER whatever the rest of the
  // chain drew (next(e) resolves to their tree), and yield entirely while a
  // survey holds the band — the props table says a hook yields to it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props && e.props.hasSurvey) return next(e);
    const ui = await safe(async () => $.ui.resolve(e), null);
    if (!ui || !ui.Box || !ui.Button || !ui.Text) return next(e);
    const t = totals();
    const openUsagePane = () => {
      $.ui.open({ id: PANE, title: 'Usage', focus: true, closeOnEscape: true }).catch(() => {});
    };
    const band = ui.Box({
      key: 'ccsl-band',
      flexDirection: 'row',
      children: [
        ui.Button({
          key: 'ccsl-usage-btn',
          label: `usage ${fmt(t.out)}o`,
          onPress: openUsagePane,
          hotkey: 'u',
        }),
        ui.Text({ key: 'ccsl-band-sep', children: ' ' }),
        ui.Button({
          key: 'ccsl-tokens-btn',
          label: `tokens ${fmt(t.in + t.out + t.cacheR + t.cacheW)}`,
          onPress: openUsagePane,
          hotkey: 'c',
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

  // The pane: sparkline of per-request output tokens + colored cumulative
  // totals. Answering (no next) means we own this pane's body entirely.
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
