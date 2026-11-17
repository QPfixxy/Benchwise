import { el, fill, toast } from '../dom.js';
import { resultPanel } from './common.js';

const STATUS = {
  pass: ['ok', '✓ Healthy'],
  warn: ['warn', '⚠ Healthy, with warnings'],
  fail: ['missing', '✕ Failing'],
  unknown: ['na', 'Not readable'],
};
const CHECK_CLASS = { ok: 'pass-text', warn: 'warn-text', fail: 'fail-text' };

const tb = (bytes) => (bytes >= 1e12 ? `${(bytes / 1e12).toFixed(1)} TB` : `${Math.round(bytes / 1e9)} GB`);
const hours = (h) => (h === null || h === undefined ? null : `${h.toLocaleString()} h`);
const years = (h) => (h >= 24 * 365 ? ` (${(h / (24 * 365)).toFixed(1)} yr)` : '');
const clean = (msg) => String(msg).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function stat(label, value, cls = '') {
  return el('div', { class: 'stat' }, el('div', { class: 'stat-label' }, label), el('div', { class: `stat-value ${cls}` }, value ?? '—'));
}

function driveCard(d) {
  const [cls, label] = STATUS[d.status] || STATUS.unknown;
  const life = d.lifeRemaining;
  return el(
    'div',
    { class: `notice ${d.external ? 'na' : cls} drive` },
    el(
      'div',
      { class: 'row between' },
      el('strong', {}, [d.model || d.name, d.capacity].filter(Boolean).join(' · ')),
      el('span', {}, d.external ? 'External, not counted' : label),
    ),
    el('p', { class: 'muted small' }, [d.kind, d.serial && `S/N ${d.serial}`, d.firmware && `FW ${d.firmware}`, d.name].filter(Boolean).join(' · ')),
    d.reason ? el('p', {}, d.reason) : null,
    d.checks?.length
      ? [
          el(
            'div',
            { class: 'stats' },
            stat('Life remaining', life !== null ? `${life}%` : 'n/a', life === null ? '' : life <= 20 ? 'fail-text' : life <= 40 ? 'warn-text' : 'pass-text'),
            stat(`Power-on time${years(d.powerOnHours)}`, hours(d.powerOnHours)),
            stat('Temperature', d.temperatureC !== null ? `${d.temperatureC}°C` : 'n/a'),
            stat('Data written', d.bytesWritten ? tb(d.bytesWritten) : 'n/a'),
            stat('Power cycles', d.powerCycles !== null ? d.powerCycles.toLocaleString() : 'n/a'),
          ),
          el(
            'table',
            { class: 'grid' },
            el(
              'tbody',
              {},
              d.checks.map((c) =>
                el(
                  'tr',
                  {},
                  el('td', {}, c.label),
                  el('td', { class: CHECK_CLASS[c.status] }, String(c.value)),
                  el('td', { class: 'muted small' }, c.detail || ''),
                ),
              ),
            ),
          ),
        ]
      : null,
  );
}

export default {
  id: 'drives',
  name: 'Drive Health',
  description:
    "Reads each internal drive's own health records (SMART): failing sectors, NVMe critical warnings, wear, error logs and power-on time. The verdict is set automatically.",
  mount(root, ctx) {
    const body = el('div', { class: 'drive-health' });
    const checkBtn = el('button', { class: 'btn', onclick: () => run() }, 'Check again');
    let running = false;

    function applyVerdict(res) {
      const cur = ctx.result;
      // Don't overwrite a verdict the operator set by hand.
      if (cur && cur.status !== 'untested' && cur.details?.source !== 'smartctl') return;
      const v = res.verdict || {};
      const drives = (res.drives || []).map((d) => d.line).filter(Boolean);
      ctx.setResult({
        status: v.status || 'untested',
        details: { source: 'smartctl', summary: v.summary, drives, warnings: v.warnings },
      });
    }

    async function run() {
      running = true;
      checkBtn.disabled = true;
      render();
      try {
        const res = await ctx.api.checkDrives();
        ctx.state.driveHealth = res;
        if (res.ok) applyVerdict(res);
      } catch (err) {
        toast(clean(err.message), 'error');
      } finally {
        running = false;
        checkBtn.disabled = false;
        render();
      }
    }

    function render() {
      const res = ctx.state.driveHealth;
      if (running) {
        return fill(body, el('div', { class: 'row' }, el('span', { class: 'spinner' }), el('span', {}, 'Reading drive health… (a few seconds per drive)')));
      }
      if (!res) return fill(body);
      if (!res.ok) {
        return fill(
          body,
          el(
            'div',
            { class: 'notice missing' },
            el('strong', {}, res.error === 'smartctl-missing' ? 'Drive health tool not found' : 'Drive check failed'),
            el('p', {}, res.message),
            res.error === 'smartctl-missing'
              ? el('p', { class: 'muted small' }, 'Release builds include it. When running from source, run "npm run vendor:smartctl" or install smartmontools.')
              : null,
          ),
        );
      }
      const v = res.verdict || {};
      const internal = res.drives.filter((d) => !d.external);
      const external = res.drives.filter((d) => d.external);
      fill(
        body,
        res.needsAdmin
          ? el('div', { class: 'notice warn' }, el('p', {}, 'Some drives need administrator access. Restart Benchwise as administrator to read them.'))
          : null,
        el(
          'div',
          { class: `notice ${v.status === 'pass' ? 'ok' : v.status === 'fail' ? 'missing' : 'na'}` },
          el('strong', {}, v.status === 'pass' ? '✓ Passed' : v.status === 'fail' ? '✕ Failed' : v.status === 'na' ? 'N/A' : 'No automatic verdict'),
          el('p', {}, v.summary),
          (v.warnings || []).map((w) => el('p', { class: 'warn-text' }, `⚠ ${w}`)),
        ),
        internal.map(driveCard),
        external.length ? el('details', {}, el('summary', {}, `External drives (${external.length}), not counted`), external.map(driveCard)) : null,
        el('p', { class: 'muted small' }, `smartctl ${res.tool?.version || ''} (${res.tool?.source === 'bundled' ? 'bundled' : 'system copy'}) · checked in ${(res.durationMs / 1000).toFixed(1)} s`),
      );
    }

    const panel = resultPanel(ctx, {
      naLabel: 'N/A (no drive)',
      hint: 'The verdict is set automatically from the drive data. Override it only with a reason in the notes.',
    });
    root.append(el('div', { class: 'row' }, checkBtn), body, panel.node);
    if (ctx.state.driveHealth) render();
    else run();
    return () => panel.dispose();
  },
};
