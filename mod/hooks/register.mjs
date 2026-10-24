// cc-statusline companion mod — quick actions + per-request usage stats.
//
// Runs INSIDE Claude Code (a plugin "mod"), unlike statusline.js which is a
// subprocess. That buys two things the status line can't do:
//   * buttons above the prompt (the AbovePrompt band) with hotkeys,
//   * direct sight of every model request via `turn.step`, so usage stats
//     arrive with zero transcript parsing.
//
// Everything here is defensive by design: the mods API is young and field
// shapes have shifted between builds, so every API call is feature-checked
// and wrapped — a missing/failed piece degrades to "not shown" and never
// breaks the session.

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

// Extract a usage record from whatever shape turn.step hands us (the exact
// field location has moved between builds — check the known spots).
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

async function persist($) {
  await safe(async () => {
    if ($.store && typeof $.store.set === 'function') {
      await $.store.set('usage-history', history.slice(-MAX_POINTS));
    }
  }, null);
}

async function openPane($) {
  await safe(async () => {
    if ($.ui && typeof $.ui.open === 'function') {
      await $.ui.open({ id: PANE, title: 'Usage', focus: true, closeOnEscape: true });
    }
  }, null);
}

export function register(on) {
  // session.start fires on load AND on every hot reload of this module —
  // re-registering the same command name is fine, it replaces itself.
  on('session.start', async ($, e, next) => {
    await safe(async () => {
      if ($.store && typeof $.store.get === 'function') {
        const saved = await $.store.get('usage-history');
        if (Array.isArray(saved)) history = saved.filter(r => r && typeof r.out === 'number');
      }
    }, null);
    await safe(async () => {
      if ($.command && typeof $.command.register === 'function') {
        await $.command.register({
          name: 'ccsl-usage',
          description: 'Token usage stats + sparkline (cc-statusline mod)',
        });
      }
    }, null);
    return next(e);
  });

  // Every model request reports its usage here — the data source the status
  // line has to parse transcripts for, handed to us directly.
  on('turn.step', async ($, e, next) => {
    const rec = usageFrom(e);
    if (rec) {
      history.push(rec);
      if (history.length > MAX_POINTS) history = history.slice(-MAX_POINTS);
      await persist($);
      await safe(async () => {
        if ($.ui && typeof $.ui.invalidate === 'function') await $.ui.invalidate('ui.render');
      }, null);
    }
    return next(e);
  });

  // /ccsl-usage — instant command, zero model turns, works while Claude runs.
  on('command.run', { name: 'ccsl-usage' }, async ($, e, next) => {
    await openPane($);
    return next(e);
  });

  // Quick-action band above the prompt: two hotkeyed buttons (u/c). Appends
  // after whatever other mods drew there; keeps their children untouched.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const ui = safe(() => ($.ui && typeof $.ui.resolve === 'function' ? $.ui.resolve(e) : null), null);
    if (!ui || !ui.Box || !ui.Button || !ui.Text) return next(e);
    const t = totals();
    return next({
      ...e,
      children: [
        ...(Array.isArray(e.children) ? e.children : []),
        ui.Box({
          key: 'ccsl-band',
          flexDirection: 'row',
          children: [
            ui.Button({
              key: 'ccsl-usage-btn',
              label: `[u]sage ${fmt(t.out)}o`,
              onPress: () => openPane($),
              hotkey: 'u',
            }),
            ui.Text({ key: 'ccsl-band-sep', children: '  ' }),
            ui.Button({
              key: 'ccsl-tokens-btn',
              label: `[c]ost ${fmt(t.in + t.out + t.cacheR + t.cacheW)}tok`,
              onPress: () => openPane($),
              hotkey: 'c',
            }),
          ],
        }),
      ],
    });
  });

  // The pane: sparkline of per-request output tokens + cumulative totals.
  // Answering (no next) means we own this pane's body entirely.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const ui = safe(() => ($.ui && typeof $.ui.resolve === 'function' ? $.ui.resolve(e) : null), null);
    if (!ui || !ui.Box || !ui.Text) return next(e);
    const t = totals();
    const recent = history.slice(-60);
    return ui.Box({
      key: 'ccsl-pane',
      flexDirection: 'column',
      children: [
        ui.Text({
          key: 'ccsl-spark',
          children: spark(recent.map(r => r.out)) || '(no usage recorded yet — run a prompt first)',
        }),
        ui.Text({
          key: 'ccsl-totals',
          children: `requests ${history.length}   out ${fmt(t.out)}   in ${fmt(t.in)}   cacheRead ${fmt(t.cacheR)}   cacheWrite ${fmt(t.cacheW)}`,
        }),
        ui.Text({ key: 'ccsl-hint', children: 'Esc closes · /ccsl-usage reopens' }),
      ],
    });
  });
}
