'use strict';

const QRCode = require('qrcode');

const FORM_LABELS = { laptop: 'Laptop', tablet: 'Tablet', 'all-in-one': 'All-in-one', desktop: 'Desktop', server: 'Server', unknown: 'Unknown' };
function unitType(sys) {
  const label = FORM_LABELS[sys.formFactor] || null;
  if (!label) return sys.chassisType || null;
  const why = sys.formFactorSource === 'battery' ? 'has a battery' : sys.formFactorSource === 'model' ? 'from model' : sys.formFactorSource === 'override' ? 'set manually' : sys.chassisType ? `${sys.chassisType} chassis` : null;
  return why ? `${label} (${why})` : label;
}

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const show = (v) => (v === null || v === undefined || v === '' ? '<span class="na">—</span>' : esc(v));

const STATUS_LABEL = { pass: 'PASS', fail: 'FAIL', na: 'N/A', untested: 'NOT TESTED', incomplete: 'INCOMPLETE' };

const TEST_NAMES = {
  mdm: 'MDM / Autopilot',
  malware: 'Malware Scan',
  camera: 'Camera',
  microphone: 'Microphone',
  speakers: 'Speakers',
  keyboard: 'Keyboard',
  display: 'Display',
  touchscreen: 'Touchscreen',
  ports: 'USB Ports',
  drives: 'Drive Health',
  cpu: 'CPU Stress',
  memory: 'Memory Test',
};

async function qr(text) {
  if (!text) return '';
  return QRCode.toString(String(text), { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
}

function kv(rows) {
  return `<table class="kv">${rows
    .filter(([, v, always]) => always || (v !== null && v !== undefined && v !== ''))
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${show(v)}</td></tr>`)
    .join('')}</table>`;
}

// Cells are escaped text, unless given as { html, cls } (trusted, built here).
function grid(headers, rows) {
  if (!rows.length) return '<p class="na">None detected</p>';
  const cell = (c) => (c && typeof c === 'object' && 'html' in c ? `<td class="${c.cls || ''}">${c.html}</td>` : `<td>${show(c)}</td>`);
  return `<table class="grid"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map(cell).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

const STATUS_CLASS = { pass: 's-pass', fail: 's-fail', na: 's-na', untested: 's-untested' };

function detailText(details) {
  return Object.entries(details || {})
    .filter(([k, v]) => !k.startsWith('_') && v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('; ');
}

const DRIVE_STATUS = { pass: ['PASS', 's-pass'], warn: ['PASS (warnings)', 's-warn'], fail: ['FAIL', 's-fail'], unknown: ['NOT READABLE', 'na'] };

// The Drive Health test reads SMART directly; prefer it over the inventory scan.
const SMART_FROM_HEALTH = { pass: 'OK', warn: 'OK (warnings)', fail: 'FAILING' };
const normSerial = (v) => String(v || '').replace(/\s+/g, '').toUpperCase();
function healthBySerial(dh, serial) {
  if (!dh?.ok || !serial) return null;
  return (dh.drives || []).find((d) => d.serial && normSerial(d.serial) === normSerial(serial)) || null;
}

/** Per-drive SMART results from the Drive Health test (only if it was run). */
function driveHealthSection(dh) {
  if (!dh?.ok || !dh.drives?.length) return '';
  const rows = dh.drives.map((d) => {
    const [label, cls] = d.external ? ['External, not counted', 'na'] : DRIVE_STATUS[d.status] || DRIVE_STATUS.unknown;
    const issues = (d.checks || []).filter((c) => c.status !== 'ok').map((c) => `${c.label}: ${c.value}`);
    return [
      [d.model || d.name, d.capacity].filter(Boolean).join(' '),
      d.serial,
      { html: esc(label), cls },
      d.lifeRemaining != null ? `${d.lifeRemaining}%` : null,
      d.powerOnHours != null ? d.powerOnHours.toLocaleString('en-US') : null,
      issues.length ? issues.join('; ') : d.reason || 'None',
    ];
  });
  return `<h2>Drive health</h2>${grid(['Drive', 'Serial', 'Health', 'Life left', 'Power-on hrs', 'Issues'], rows)}`;
}

/** TPM / Secure Boot / BitLocker rows (Windows only). */
function securityRows(sec) {
  if (!sec) return [];
  const j = (...xs) => xs.filter(Boolean).join(' · ');
  return [
    ['TPM', sec.tpm ? (sec.tpm.present ? j(sec.tpm.version && `TPM ${sec.tpm.version}`, sec.tpm.manufacturer) || 'Present' : 'Not present') : null],
    ['Secure Boot', { enabled: 'On', disabled: 'Off', unsupported: 'Not supported (legacy BIOS)' }[sec.secureBoot] || null],
    ['BitLocker', sec.bitLocker ? j(sec.bitLocker.conversion, sec.bitLocker.protection) : null],
  ];
}

async function renderReportHtml(audit, { logoDataUrl } = {}) {
  const hw = audit.hardware || {};
  const sys = hw.system || {};
  const cpu = hw.cpu || {};
  const mem = hw.memory || {};
  const bat = hw.battery || {};
  const [tagQr, serialQr] = await Promise.all([qr(audit.assetTag), qr(sys.serial)]);

  const tests = Object.entries(audit.tests || {});
  const cores = [cpu.physicalCores && `${cpu.physicalCores} cores`, cpu.threads && `${cpu.threads} threads`]
    .filter(Boolean)
    .join(' / ');
  const hybrid =
    cpu.performanceCores && cpu.efficiencyCores ? ` (${cpu.performanceCores}P + ${cpu.efficiencyCores}E)` : '';

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(audit.assetTag)}</title><style>
  @page { size: Letter; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { font: 9.5pt/1.35 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: #111; margin: 0; }
  header { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid #111; padding-bottom: 8px; }
  header img { height: 34px; }
  header .title { flex: 1; }
  header h1 { font-size: 15pt; margin: 0; }
  header .sub { color: #555; font-size: 8.5pt; }
  .overall { font-weight: 700; font-size: 12pt; padding: 6px 12px; border-radius: 4px; border: 2px solid; }
  .s-pass { color: #0a6b2d; border-color: #0a6b2d; } .s-warn { color: #8a5a00; } .s-fail { color: #b00020; border-color: #b00020; }
  .s-incomplete, .s-untested { color: #8a5a00; border-color: #8a5a00; } .s-na { color: #555; border-color: #999; }
  .ids { display: flex; gap: 18px; margin: 10px 0 4px; }
  .id { display: flex; gap: 8px; align-items: center; }
  .id svg { width: 58px; height: 58px; }
  .id .label { font-size: 7.5pt; text-transform: uppercase; color: #555; letter-spacing: .04em; }
  .id .value { font: 600 11pt ui-monospace, Menlo, Consolas, monospace; }
  h2 { font-size: 10.5pt; margin: 12px 0 4px; padding-bottom: 2px; border-bottom: 1px solid #bbb; break-after: avoid; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; }
  table { width: 100%; border-collapse: collapse; break-inside: avoid; }
  .kv th { text-align: left; font-weight: 500; color: #444; width: 38%; padding: 1px 6px 1px 0; vertical-align: top; }
  .kv td { padding: 1px 0; }
  .grid th { text-align: left; font-size: 8pt; color: #444; border-bottom: 1px solid #999; padding: 2px 4px; }
  .grid td { border-bottom: 1px solid #e3e3e3; padding: 2px 4px; vertical-align: top; }
  .status { font-weight: 700; white-space: nowrap; }
  .na { color: #888; }
  .warn { color: #8a5a00; font-size: 8pt; margin: 2px 0; }
  .notes { white-space: pre-wrap; border: 1px solid #ccc; padding: 6px; min-height: 28px; }
  footer { margin-top: 14px; font-size: 7.5pt; color: #666; border-top: 1px solid #ccc; padding-top: 4px; }
  .sign { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 22px; }
  .sign div { border-top: 1px solid #111; padding-top: 2px; font-size: 8pt; color: #444; }
</style></head><body>
<header>
  ${logoDataUrl ? `<img src="${logoDataUrl}" alt="">` : ''}
  <div class="title">
    <h1>Hardware Audit Report</h1>
    <div class="sub">${esc(new Date(audit.completedAt).toLocaleString())}${audit.station ? ` · Station ${esc(audit.station)}` : ''}${audit.technician ? ` · Tech ${esc(audit.technician)}` : ''}</div>
  </div>
  <div class="overall s-${esc(audit.overall)}">${esc(STATUS_LABEL[audit.overall] || audit.overall)}</div>
</header>

<div class="ids">
  <div class="id">${tagQr}<div><div class="label">${esc(audit.assetTagLabel || 'Asset Tag')}</div><div class="value">${esc(audit.assetTag)}</div></div></div>
  ${sys.serial ? `<div class="id">${serialQr}<div><div class="label">System Serial</div><div class="value">${esc(sys.serial)}</div></div></div>` : ''}
</div>

<div class="cols">
  <section><h2>System</h2>${kv([
    ['Manufacturer', sys.manufacturer, true],
    ['Model', sys.model, true],
    ['Version / SKU', [sys.version, sys.sku].filter(Boolean).join(' · ')],
    ['Serial', sys.serial, true],
    ['Unit type', unitType(sys)],
    ['BIOS', [sys.bios?.vendor, sys.bios?.version, sys.bios?.releaseDate].filter(Boolean).join(' · ')],
    ['OS', [sys.os?.distro, sys.os?.release, sys.os?.arch].filter(Boolean).join(' ')],
    ...securityRows(hw.security),
  ])}</section>
  <section><h2>Processor</h2>${kv([
    ['Model', cpu.name, true],
    ['Cores', cores + hybrid],
    ['Base / Max', [cpu.baseSpeed, cpu.maxSpeed].filter(Boolean).join(' / ')],
  ])}
  <h2>Memory</h2>${kv([
    ['Installed', mem.total, true],
    ['Slots used', mem.slotsTotal ? `${mem.slotsUsed} of ${mem.slotsTotal}` : null],
  ])}</section>
</div>

${
  mem.slots?.length
    ? grid(
        ['Slot', 'Size', 'Type', 'Speed', 'Form', 'Manufacturer', 'Part #'],
        mem.slots.map((s) =>
          s.empty ? [s.slot, 'Empty', '', '', '', '', ''] : [s.slot, s.size, s.type, s.speed, s.formFactor, s.manufacturer, s.partNumber],
        ),
      )
    : ''
}

<h2>Storage</h2>
${grid(
  ['Model', 'Capacity', 'Type', 'Serial', 'SMART', 'Power-on hrs'],
  (hw.storage || []).map((d) => {
    const h = healthBySerial(hw.driveHealth, d.serial);
    return [d.model, d.capacity, d.kind, d.serial, h ? SMART_FROM_HEALTH[h.status] || d.smartStatus : d.smartStatus, h?.powerOnHours ?? d.powerOnHours];
  }),
)}
${driveHealthSection(hw.driveHealth)}

<div class="cols">
  <section><h2>Graphics</h2>${grid(
    ['Type', 'Model', 'VRAM'],
    (hw.graphics?.gpus || []).map((g) => [g.kind === 'discrete' ? 'Dedicated' : 'Integrated', g.model, g.vram]),
  )}
  ${
    hw.graphics?.displays?.length
      ? grid(
          ['Display', 'Resolution', 'Size'],
          hw.graphics.displays.map((d) => [
            d.builtin ? 'Built-in' : d.model || d.connection || 'External',
            d.resolution,
            d.sizeInches ? `${d.sizeInches}"` : null,
          ]),
        )
      : ''
  }</section>
  <section><h2>Battery</h2>${
    bat.present
      ? kv([
          ['Health', bat.healthPercent != null ? `${bat.healthPercent}%` : null, true],
          ['Cycle count', bat.cycleCount],
          ['Full / Design', [bat.fullChargeCapacity, bat.designedCapacity].filter(Boolean).join(' / ')],
          ['Charge', bat.chargePercent != null ? `${bat.chargePercent}%${bat.charging ? ' (charging)' : ''}` : null],
          ['Model', [bat.manufacturer, bat.model].filter(Boolean).join(' ')],
        ])
      : '<p class="na">No battery detected</p>'
  }</section>
</div>

<div class="cols">
  <section><h2>Network</h2>${grid(
    ['Type', 'Interface', 'MAC'],
    (hw.network || []).map((x) => [x.type, x.name, x.mac]),
  )}</section>
  <section><h2>Audio / Video Devices</h2>${kv([
    ['Cameras', (audit.media?.cameras || []).join(', ') || null, true],
    ['Microphones', (audit.media?.microphones || []).join(', ') || null, true],
    ['Speakers', (audit.media?.speakers || []).join(', ') || null, true],
  ])}</section>
</div>

<h2>Functional Tests</h2>
${grid(
  ['Test', 'Result', 'Details', 'Notes'],
  tests.map(([id, t]) => [
    TEST_NAMES[id] || id,
    { html: esc(STATUS_LABEL[t.status] || t.status), cls: `status ${STATUS_CLASS[t.status] || ''}` },
    detailText(t.details),
    t.notes,
  ]),
)}

${audit.notes ? `<h2>Notes</h2><div class="notes">${esc(audit.notes)}</div>` : ''}
${(hw.warnings || []).map((w) => `<p class="warn">⚠ ${esc(w)}</p>`).join('')}

<div class="sign"><div>Technician signature</div><div>Date</div></div>

<footer>Report ${esc(audit.id)} · ${esc(audit.app?.name)} ${esc(audit.app?.version)} on ${esc(audit.app?.platform)} · Hardware collected ${esc(hw.collectedAt)}</footer>
</body></html>`;
}

module.exports = { renderReportHtml, esc };
