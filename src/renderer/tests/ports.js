import { el, fill, toast } from '../dom.js';
import { resultPanel } from './common.js';

const POLL_MS = 1500;
const fmtMB = (v) => (v == null ? '—' : `${v} MB/s`);
const fmtBytes = (b) => (b == null ? '' : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

export default {
  id: 'ports',
  name: 'USB Ports',
  description:
    'Plug the Benchwise test drive into each USB port, one at a time. For every port Benchwise records the physical port, link speed, read/write speed and a data-integrity check, then ejects the drive so you can move to the next port.',

  mount(root, ctx) {
    const api = ctx.api.ports;
    const prev = ctx.result?.details || {};
    let expected = Number(prev.portsExpected) || '';
    const prior = Array.isArray(prev._results) ? prev._results : []; // results from earlier visits this audit
    let live = { results: [], present: [], waitingRemoval: [], running: null };
    let timer = 0;
    let busy = false;
    let disposed = false;
    // Auto-fail once per corruption; don't re-fail after the operator reviewed it.
    let failedOnCorruption = prior.some((r) => !r.verified);

    const status = el('div', { class: 'port-status' });
    const counter = el('div', { class: 'kb-counter' });
    const tableBox = el('div', {});

    const allResults = () => [...prior, ...live.results.map((r) => ({ ...r }))];

    /** Latest result per physical port, lettered A, B, C… in order first seen. */
    function portRows() {
      const order = [];
      const latest = new Map();
      for (const r of allResults()) {
        if (!latest.has(r.portKey)) order.push(r.portKey);
        latest.set(r.portKey, { ...r, tries: (latest.get(r.portKey)?.tries || 0) + 1 });
      }
      return order.map((k, i) => ({ ...latest.get(k), letter: String.fromCharCode(65 + (i % 26)) }));
    }

    function details() {
      const rows = portRows();
      return {
        portsExpected: expected || null,
        portsConfirmed: rows.filter((r) => r.verified).length,
        portResults: rows.map(
          (r) =>
            `Port ${r.letter}${r.location ? ` [${r.location}]` : ''}: ${r.verified ? 'OK' : 'DATA ERROR'}${r.speed ? `, ${r.speed}` : ''}, read ${fmtMB(r.readMBps)}, write ${fmtMB(r.writeMBps)}`,
        ),
        _results: allResults(),
      };
    }

    function render() {
      const rows = portRows();
      const verified = rows.filter((r) => r.verified).length;
      const corrupt = rows.some((r) => !r.verified);
      const maxLink = Math.max(0, ...rows.map((r) => r.speedMbps || 0));
      const noLocation = rows.length && rows.every((r) => !r.location);

      fill(
        counter,
        el('strong', {}, `${verified}${expected ? ` / ${expected}` : ''}`),
        ` port${verified === 1 ? '' : 's'} confirmed`,
      );

      if (live.running) {
        fill(status, el('span', { class: 'spinner' }), el('span', {}, live.running.phase));
        status.className = 'port-status busy';
      } else if (live.waitingRemoval.length) {
        fill(status, 'A test drive is already plugged in. Unplug it, then plug it into the first port to begin.');
        status.className = 'port-status warn';
      } else if (live.present.length) {
        fill(status, 'Done: unplug the test drive and plug it into the next port.');
        status.className = 'port-status ok';
      } else {
        fill(status, rows.length ? 'Plug the test drive into the next port.' : 'Plug the test drive into a USB port.');
        status.className = 'port-status idle';
      }
      if (live.lastError) status.append(el('div', { class: 'fail-text small' }, live.lastError));

      fill(
        tableBox,
        rows.length
          ? el(
              'table',
              { class: 'grid' },
              el('thead', {}, el('tr', {}, ['Port', 'Link speed', 'Read', 'Write', 'Data check', 'Device'].map((h) => el('th', {}, h)))),
              el(
                'tbody',
                {},
                rows.map((r) =>
                  el(
                    'tr',
                    {},
                    el('td', {}, el('strong', {}, `Port ${r.letter}`), r.location ? el('div', { class: 'muted small' }, r.location) : null, r.tries > 1 ? el('div', { class: 'muted small' }, `tested ${r.tries}×`) : null),
                    el(
                      'td',
                      {},
                      r.speed || el('span', { class: 'muted' }, 'n/a on this OS'),
                      r.speedMbps && maxLink > r.speedMbps ? el('div', { class: 'warn-text small' }, 'Slower link than other ports (fine if this is a USB 2 port)') : null,
                    ),
                    el('td', {}, fmtMB(r.readMBps)),
                    el('td', {}, fmtMB(r.writeMBps)),
                    el('td', {}, r.verified ? el('span', { class: 'pass-text' }, '✓ Verified') : el('span', { class: 'fail-text' }, `✕ ${r.error || 'Failed'}`)),
                    el('td', { class: 'small' }, r.device || '—', r.ejected === false ? el('div', { class: 'warn-text' }, 'Not ejected: eject before unplugging') : null),
                  ),
                ),
              ),
            )
          : el('p', { class: 'muted' }, 'No ports tested yet.'),
        noLocation ? el('p', { class: 'muted small' }, 'This system does not report physical port locations, so each insertion counts as one port.') : null,
      );

      // Verdicts: corruption fails immediately; enough verified ports passes.
      const status_ = ctx.result?.status;
      if (corrupt && !failedOnCorruption && status_ !== 'fail') {
        failedOnCorruption = true;
        ctx.setResult({ status: 'fail', details: details() });
      } else if (!corrupt && expected && verified >= expected && status_ !== 'fail' && status_ !== 'pass') {
        ctx.setResult({ status: 'pass', details: details() });
      } else {
        ctx.setResult({ details: details() });
      }
    }

    async function poll() {
      if (busy || disposed) return;
      busy = true;
      try {
        live = await api.poll();
        render();
      } catch (err) {
        live.lastError = err.message;
        render();
      } finally {
        busy = false;
        if (!disposed) timer = setTimeout(poll, POLL_MS);
      }
    }

    // ---------------------------------------------------------------- prepare

    const volumesBox = el('div', {});
    async function findVolumes() {
      fill(volumesBox, el('div', { class: 'loading' }, el('span', { class: 'spinner sm' }), 'Looking for drives…'));
      const vols = await api.volumes().catch(() => []);
      fill(
        volumesBox,
        vols.length
          ? el(
              'table',
              { class: 'grid' },
              el(
                'tbody',
                {},
                vols.map((v) =>
                  el(
                    'tr',
                    {},
                    el('td', {}, el('strong', {}, v.label), el('div', { class: 'muted small' }, v.mount)),
                    el('td', { class: 'small' }, v.totalBytes ? `${fmtBytes(v.freeBytes)} free of ${fmtBytes(v.totalBytes)}` : ''),
                    el(
                      'td',
                      { class: 'actions' },
                      v.isTestDrive
                        ? el('span', { class: 'pass-text' }, '✓ Test drive')
                        : el('button', { class: 'btn sm', onclick: () => prepare(v) }, 'Make test drive'),
                    ),
                  ),
                ),
              ),
            )
          : el('p', { class: 'muted' }, 'No removable drives found. Plug in a flash drive and try again.'),
      );
    }

    async function prepare(v) {
      if (
        !confirm(
          `Make "${v.label}" a Benchwise test drive?\n\nThis adds a BENCHWISE-TEST-DRIVE folder (about 64 MB) and a small marker file. Nothing on the drive is erased or reformatted.`,
        )
      )
        return;
      fill(volumesBox, el('div', { class: 'loading' }, el('span', { class: 'spinner sm' }), `Preparing ${v.label}…`));
      try {
        const res = await api.prepare(v.mount);
        toast(res.ejected ? 'Test drive ready and ejected. Unplug it, then plug it into the first port.' : 'Test drive ready. Eject and unplug it, then plug it into the first port.', 'success');
        fill(volumesBox, el('p', { class: 'pass-text' }, `✓ ${v.label} is now a test drive.`));
      } catch (err) {
        toast(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
        findVolumes();
      }
    }

    // ---------------------------------------------------------------- layout

    const panel = resultPanel(ctx, {
      getDetails: details,
      naLabel: 'N/A (no USB ports)',
      hint: 'Test every USB-A and USB-C port (use an adapter for USB-C). HDMI, Ethernet, SD and headphone jacks aren’t covered yet; check them by hand and add notes.',
    });

    root.append(
      el(
        'div',
        { class: 'row between' },
        el(
          'label',
          { class: 'field inline' },
          el('span', {}, 'USB ports on this unit'),
          el('input', {
            type: 'number',
            min: '0',
            max: '20',
            value: expected,
            class: 'narrow',
            oninput: (e) => {
              expected = Number(e.target.value) || '';
              render();
            },
          }),
        ),
        counter,
      ),
      status,
      tableBox,
      el(
        'details',
        { class: 'card prepare' },
        el('summary', {}, 'Need a test drive? Prepare any flash drive (one-time setup)'),
        el(
          'p',
          { class: 'muted small' },
          'Any USB flash drive with ~100 MB free works. A USB 3 drive lets Benchwise tell USB 3 ports from USB 2 ones by speed. Keep it labelled as the bench test drive.',
        ),
        el('button', { class: 'btn', onclick: findVolumes }, 'Find drives'),
        volumesBox,
      ),
      panel.node,
    );

    render();
    api.start().then((s) => {
      live = s;
      render();
      poll();
    });

    return () => {
      disposed = true;
      clearTimeout(timer);
      api.stop();
      // Keep this visit's results for when the operator comes back.
      if (live.results.length) ctx.setResult({ details: { ...details(), _results: allResults() } });
      panel.dispose();
    };
  },
};
