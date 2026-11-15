import { el, statusBadge } from '../dom.js';
import { rankDevices, describeDevice } from '../devices.js';

/**
 * Operator verdict panel shared by every test: Pass / Fail / N/A + notes.
 * `getDetails` lets a test attach measured data to a manual verdict.
 */
export function resultPanel(ctx, { getDetails = () => ({}), naLabel = 'N/A (not present)', hint } = {}) {
  const badge = el('span', {});
  const notes = el('textarea', {
    rows: 2,
    placeholder: 'Notes (e.g. "dead pixel top-left", "right speaker crackles")',
    value: ctx.result?.notes || '',
    oninput: (e) => ctx.setResult({ notes: e.target.value }),
  });
  const mark = (status) => () => ctx.setResult({ status, details: { ...ctx.result?.details, ...getDetails() } });
  const buttons = {
    pass: el('button', { class: 'btn pass', onclick: mark('pass') }, '✓ Pass'),
    fail: el('button', { class: 'btn fail', onclick: mark('fail') }, '✕ Fail'),
    na: el('button', { class: 'btn', onclick: mark('na') }, naLabel),
  };
  const refresh = () => {
    const status = ctx.result?.status || 'untested';
    badge.replaceChildren(statusBadge(status));
    for (const [k, b] of Object.entries(buttons)) b.classList.toggle('selected', k === status);
  };
  const off = ctx.onChange(refresh);
  refresh();
  const node = el(
    'div',
    { class: 'result-panel' },
    el('div', { class: 'row between' }, el('strong', {}, 'Result'), badge),
    hint ? el('p', { class: 'muted small' }, hint) : null,
    el('div', { class: 'row' }, buttons.pass, buttons.fail, buttons.na),
    notes,
  );
  return { node, dispose: off };
}

export function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

/**
 * Device <select> for a mediaDevices kind, built-in devices first (so a
 * Continuity iPhone camera or a headset is never the default) and each option
 * labelled with what it is. `devices[0]` is the recommended default.
 */
export async function deviceSelect(kind, onPick) {
  const devices = rankDevices(
    (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === kind && d.deviceId !== 'communications' && d.deviceId !== 'default',
    ),
  );
  const select = el(
    'select',
    { onchange: (e) => onPick(e.target.value, e.target.selectedOptions[0]?.dataset.label) },
    devices.map((d, i) =>
      el('option', { value: d.deviceId, dataset: { label: d.label || `Device ${i + 1}` } }, describeDevice(d.label || `Device ${i + 1}`)),
    ),
  );
  return { select, devices };
}
