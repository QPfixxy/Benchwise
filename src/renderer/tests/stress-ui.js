import { el, fill, toast } from '../dom.js';
import { resultPanel } from './common.js';

const gb = (b) => `${(b / 1024 ** 3).toFixed(1)} GB`;
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const clean = (msg) => String(msg).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/**
 * Shared UI for CPU and memory stress tests. The run itself lives in the main
 * process and app-level state (state.stress), so leaving this page does NOT
 * stop it: the operator can do other tests meanwhile.
 */
export function mountStress(root, ctx, { kind, intro }) {
  const api = ctx.api.stress;
  let profiles = [];
  let profile = 'quick';
  const profileSelect = el('select', { onchange: (e) => (profile = e.target.value) });
  const startBtn = el('button', { class: 'btn primary big', onclick: start }, 'Start');
  const stopBtn = el('button', { class: 'btn fail big', onclick: () => api.stop() }, 'Stop');
  const live = el('div', {});
  const outcome = el('div', {});

  async function start() {
    startBtn.disabled = true;
    try {
      await api.start(kind, profile);
    } catch (err) {
      toast(clean(err.message), 'error');
    } finally {
      startBtn.disabled = false;
    }
  }

  function stat(label, value, cls = '') {
    return el('div', { class: 'stat' }, el('div', { class: 'stat-label' }, label), el('div', { class: `stat-value ${cls}` }, value ?? '—'));
  }

  function render() {
    const s = ctx.state.stress || {};
    const run = s.running;
    const mine = run?.kind === kind;
    const other = run && !mine;
    const p = run?.progress || {};

    profileSelect.disabled = Boolean(run);
    startBtn.classList.toggle('hidden', Boolean(mine));
    startBtn.disabled = Boolean(other);
    stopBtn.classList.toggle('hidden', !mine);

    if (other) {
      fill(live, el('div', { class: 'notice warn' }, el('p', {}, `The ${run.kind === 'cpu' ? 'CPU stress test' : 'memory test'} is running. Only one stress test runs at a time.`)));
    } else if (mine) {
      const pct =
        kind === 'cpu'
          ? Math.min(100, ((p.elapsedMs || 0) / run.plan.durationMs) * 100)
          : p.totalWork
            ? Math.min(100, (p.processed / p.totalWork) * 100)
            : 0;
      const errs = p.errorCount || 0;
      fill(
        live,
        el('div', { class: 'progress' }, el('div', { class: 'progress-fill', style: { width: `${pct.toFixed(1)}%` } })),
        el(
          'div',
          { class: 'stats' },
          kind === 'cpu'
            ? [
                stat('Elapsed', `${clock(p.elapsedMs || 0)} / ${clock(run.plan.durationMs)}`),
                stat('Threads', p.threads),
                stat('Verified rounds', p.rounds),
                stat('Errors', errs, errs ? 'fail-text' : 'pass-text'),
                stat('CPU temp', p.tempC ? `${Math.round(p.tempC)}°C` : 'n/a'),
                stat('Clock', p.ghz ? `${p.ghz.toFixed(2)} GHz` : 'n/a'),
              ]
            : [
                stat('Progress', `${pct.toFixed(0)}%`),
                stat('Elapsed', clock(p.elapsedMs || 0)),
                stat('Allocated', p.allocated ? `${gb(p.allocated)} of ${gb(run.plan.bytes)}` : 'allocating…'),
                stat('Threads', p.threads),
                stat('Errors', errs, errs ? 'fail-text' : 'pass-text'),
              ],
        ),
        errs ? el('p', { class: 'fail-text' }, 'Errors detected: this unit will fail. Letting the run finish records how widespread the problem is.') : null,
        el('p', { class: 'muted small' }, 'You can switch to other tests while this runs; the result is recorded automatically when it finishes.'),
      );
    } else {
      fill(live);
    }

    const done = s.last?.[kind];
    fill(
      outcome,
      done && !mine
        ? el(
            'div',
            { class: `notice ${done.verdict.status === 'fail' ? 'missing' : done.verdict.status === 'pass' ? 'ok' : 'na'}` },
            el('strong', {}, done.verdict.status === 'pass' ? '✓ Passed' : done.verdict.status === 'fail' ? '✕ Failed' : 'No verdict'),
            el('p', {}, done.verdict.summary),
            done.verdict.warnings.map((w) => el('p', { class: 'warn-text' }, `⚠ ${w}`)),
            (done.verdict.details.errorSamples || []).length
              ? el('details', {}, el('summary', {}, 'Error details'), el('ul', { class: 'small' }, done.verdict.details.errorSamples.map((e) => el('li', {}, e))))
              : null,
          )
        : null,
    );
  }

  const panel = resultPanel(ctx, {
    naLabel: 'N/A (not required)',
    hint: 'The verdict is set automatically from the run. Override it only with a reason in the notes.',
  });

  root.append(
    el('p', {}, intro),
    el('div', { class: 'row' }, el('label', { class: 'field inline' }, el('span', {}, 'Profile'), profileSelect), startBtn, stopBtn),
    live,
    outcome,
    panel.node,
  );

  api.profiles().then((all) => {
    profiles = all[kind] || [];
    profileSelect.replaceChildren(...profiles.map((pr) => el('option', { value: pr.id, selected: pr.id === profile }, pr.label)));
  });
  render();
  const off = ctx.onChange(render);
  return () => {
    off();
    panel.dispose();
  };
}
