'use strict';

// Compliance PDFs, drawn on demand from a stored record (never stored).
// PDFKit with its built-in fonts: pure JavaScript, no browser engine, so it
// works the same on Ubuntu and Windows servers. All record values are drawn
// as text, never interpreted.

const PDFDocument = require('pdfkit');
const { canonicalJson, sha256 } = require('./records');

const TEST_NAMES = {
  mdm: 'MDM / Autopilot',
  malware: 'Malware Scan',
  display: 'Display',
  keyboard: 'Keyboard',
  touchscreen: 'Touchscreen',
  camera: 'Camera',
  microphone: 'Microphone',
  speakers: 'Speakers',
  ports: 'USB Ports',
  drives: 'Drive Health',
  cpu: 'CPU Stress',
  memory: 'Memory Test',
};
const FORM = { laptop: 'Laptop', tablet: 'Tablet', 'all-in-one': 'All-in-one', desktop: 'Desktop', server: 'Server', unknown: 'Unknown' };
const STATUS = { pass: 'PASS', fail: 'FAIL', na: 'N/A', untested: 'NOT TESTED', incomplete: 'INCOMPLETE' };
const COLOR = { pass: '#15803d', fail: '#b91c1c', incomplete: '#a16207', untested: '#a16207', na: '#6b7280' };

// The built-in PDF fonts cover Latin-1 plus a few typographic characters.
const EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const pdfText = (v) =>
  String(v ?? '')
    .replace(/[✓✔]/g, 'OK')
    .replace(/[✕✗✘]/g, 'X')
    .replace(/→/g, '->')
    .replace(/[^\n\x20-\xff]/g, (c) => (EXTRA.has(c) ? c : '?'));

const join = (...xs) => xs.filter((x) => x !== null && x !== undefined && x !== '').join(' · ');
const when = (iso) => (iso ? new Date(iso).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : null);

/** Renders one record to a PDF Buffer. `a` is a stored audit (getAudit). */
function renderRecordPdf(a, { generatedAt = new Date() } = {}) {
  const r = a.record || {};
  const hw = r.hardware || {};
  const sys = hw.system || {};
  const doc = new PDFDocument({ size: 'LETTER', margin: 48, bufferPages: true, info: { Title: `Benchwise record ${a.serial || a.id}`, Author: 'Benchwise Server', Subject: 'Hardware audit record' } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 24; // room for the footer
  const ensure = (h) => {
    if (doc.y + h > bottom()) doc.addPage();
  };

  const heading = (text) => {
    ensure(40);
    doc.moveDown(0.6).font('Helvetica-Bold').fontSize(11).fillColor('#111').text(pdfText(text), left, doc.y);
    doc.moveTo(left, doc.y + 2).lineTo(left + width, doc.y + 2).lineWidth(0.5).strokeColor('#bbb').stroke();
    doc.moveDown(0.4);
  };

  /** Label/value rows in two columns; empty values are skipped. */
  const kv = (rows) => {
    const labelW = 130;
    for (const [k, v] of rows) {
      if (v === null || v === undefined || v === '') continue;
      const text = pdfText(v);
      const h = doc.font('Helvetica').fontSize(9).heightOfString(text, { width: width - labelW });
      ensure(h + 2);
      const y = doc.y;
      doc.font('Helvetica').fontSize(9).fillColor('#666').text(pdfText(k), left, y, { width: labelW - 8 });
      doc.fillColor('#111').text(text, left + labelW, y, { width: width - labelW });
      doc.y = Math.max(doc.y, y + h) + 2;
    }
  };

  /** A simple table: [{ title, width (fraction) }], rows of strings (or { text, color }). */
  const table = (cols, rows) => {
    const widths = cols.map((c) => c.width * width);
    ensure(44); // never a header stranded at the bottom of a page without its first row
    const draw = (cells, { bold = false, header = false } = {}) => {
      const font = bold ? 'Helvetica-Bold' : 'Helvetica';
      const texts = cells.map((c) => pdfText(typeof c === 'object' && c ? c.text : c));
      const h = Math.max(...texts.map((t, i) => doc.font(font).fontSize(8.5).heightOfString(t || ' ', { width: widths[i] - 6 }))) + 4;
      ensure(h);
      const y = doc.y;
      let x = left;
      cells.forEach((c, i) => {
        doc.font(font).fontSize(8.5).fillColor(header ? '#555' : (typeof c === 'object' && c?.color) || '#111').text(texts[i], x + 3, y + 2, { width: widths[i] - 6 });
        x += widths[i];
      });
      doc.y = y + h;
      doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.3).strokeColor(header ? '#999' : '#ddd').stroke();
    };
    draw(cols.map((c) => c.title), { bold: true, header: true });
    for (const row of rows) draw(row);
    doc.moveDown(0.3);
  };

  // ---------------------------------------------------------------- header
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#13233a').text('Benchwise Audit Record', left, doc.y);
  doc.font('Helvetica').fontSize(9).fillColor('#555').text(pdfText(join(`Site ${a.site}`, a.station && `Station ${a.station}`, `Completed ${when(a.completedAt)}`)));
  const overall = String(a.overall || 'incomplete');
  doc.moveDown(0.4).font('Helvetica-Bold').fontSize(13).fillColor(COLOR[overall] || '#111').text(`Result: ${STATUS[overall] || overall.toUpperCase()}`);

  heading('Unit');
  kv([
    ['Serial number', a.serial],
    ['System UUID', a.uuid],
    ['Asset tag', a.assetTag],
    ['Manufacturer / model', join(sys.manufacturer, sys.model)],
    ['Version / SKU', join(sys.version, sys.sku)],
    ['Unit type', FORM[sys.formFactor] || sys.formFactor],
    ['BIOS', join(sys.bios?.vendor, sys.bios?.version, sys.bios?.releaseDate)],
    ['Operating system', join(sys.os?.distro, sys.os?.release, sys.os?.arch)],
  ]);

  heading('Audit');
  kv([
    ['Profile', a.profile === 'intake' ? 'Intake checks (Windows setup)' : 'Full audit'],
    ['Technician', a.technician],
    ['Completed', when(a.completedAt)],
    ['Received by server', when(a.receivedAt)],
    ['Benchwise version', a.appVersion],
    ['Notes', r.notes],
  ]);

  const mdm = hw.intake?.mdm;
  if (mdm || r.tests?.mdm) {
    heading('MDM / Autopilot lock check');
    kv([
      ['Result', mdm?.status ? mdm.status.toUpperCase() : STATUS[r.tests?.mdm?.status]],
      ['Summary', mdm?.verdict?.summary || r.tests?.mdm?.details?.summary],
      ['Tenant', mdm?.tenant],
      ['Client', mdm?.vendor],
      ['Microsoft confirmation', mdm?.confirmation],
      ['Checked', when(mdm?.checkedAt)],
    ]);
  }

  const mal = hw.intake?.malware;
  if (mal || r.tests?.malware) {
    heading('Malware scan (Microsoft Defender, audit mode)');
    kv([
      ['Result', mal?.status ? mal.status.toUpperCase() : STATUS[r.tests?.malware?.status]],
      ['Summary', mal?.verdict?.summary || r.tests?.malware?.details?.summary],
      ['Definitions', mal?.defender?.signatures && `${mal.defender.signatures}${mal.definitionsUpdated ? ' (updated before scan)' : ' (NOT updated)'}`],
      ['Audit mode', mal ? (mal.auditMode ? 'On: threats left in place' : 'Blocked by Tamper Protection') : null],
      ['Files scanned', mal?.filesScanned],
    ]);
    if (mal?.threats?.length) {
      table(
        [{ title: 'Threat', width: 0.38 }, { title: 'Severity', width: 0.12 }, { title: 'When', width: 0.12 }, { title: 'Location', width: 0.38 }],
        mal.threats.map((t) => [t.name, t.severity || '', t.newThisScan ? 'This scan' : 'Earlier', (t.resources || []).slice(0, 3).join('\n')]),
      );
    }
  }

  const sec = hw.security;
  if (sec) {
    heading('Security');
    kv([
      ['TPM', sec.tpm ? (sec.tpm.present ? join(sec.tpm.version && `TPM ${sec.tpm.version}`, sec.tpm.manufacturer) : 'Not present') : null],
      ['Secure Boot', { enabled: 'On', disabled: 'Off', unsupported: 'Not supported (legacy BIOS)' }[sec.secureBoot]],
      ['BitLocker', sec.bitLocker ? join(sec.bitLocker.conversion, sec.bitLocker.protection) : null],
    ]);
  }

  heading('Hardware');
  kv([
    ['Processor', join(hw.cpu?.name, hw.cpu?.physicalCores && `${hw.cpu.physicalCores} cores`, hw.cpu?.threads && `${hw.cpu.threads} threads`)],
    ['Memory', join(hw.memory?.total, hw.memory?.slotsTotal && `${hw.memory.slotsUsed} of ${hw.memory.slotsTotal} slots`)],
    ['Battery', hw.battery?.present ? join(hw.battery.healthPercent != null && `${hw.battery.healthPercent}% health`, hw.battery.cycleCount != null && `${hw.battery.cycleCount} cycles`) : 'None'],
  ]);
  if (hw.storage?.length) {
    table(
      [{ title: 'Storage', width: 0.4 }, { title: 'Capacity', width: 0.14 }, { title: 'Type', width: 0.14 }, { title: 'Serial', width: 0.32 }],
      hw.storage.map((d) => [d.model, d.capacity, d.kind, d.serial]),
    );
  }
  if (hw.driveHealth?.drives?.length) {
    table([{ title: 'Drive health', width: 1 }], hw.driveHealth.drives.map((d) => [d.line || d.model || d.name]));
  }

  heading('Tests');
  table(
    [{ title: 'Test', width: 0.2 }, { title: 'Result', width: 0.13 }, { title: 'Details', width: 0.47 }, { title: 'Notes', width: 0.2 }],
    Object.entries(r.tests || {}).map(([id, t]) => [
      TEST_NAMES[id] || id,
      { text: STATUS[t.status] || t.status, color: COLOR[t.status] },
      t.details?.summary || t.details?.autoNa || '',
      t.notes || '',
    ]),
  );

  heading('Integrity');
  kv([
    ['Record id', a.id],
    ['Record SHA-256', sha256(canonicalJson(r))],
    ['Chain hash', a.hash],
    ['Previous link', a.prevHash || '(first record of this site)'],
  ]);
  doc.font('Helvetica').fontSize(8).fillColor('#666').text(
    'This PDF was drawn from the stored record at the time of export; the server keeps records, not PDFs. The record SHA-256 and chain hash can be checked against the server ("Verify" for the site) to confirm the record has not been altered.',
    left,
    doc.y + 4,
    { width },
  );

  // Footer on every page.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - doc.page.margins.bottom - 10;
    doc.font('Helvetica').fontSize(7.5).fillColor('#888').text(
      pdfText(`Benchwise · ${a.site} · record ${a.id} · exported ${when(generatedAt.toISOString())} · page ${i - range.start + 1} of ${range.count}`),
      left,
      y,
      { width, align: 'center', lineBreak: false },
    );
  }
  doc.end();
  return done;
}

/** File name for a record's PDF: serial (or id) and completion date. */
function pdfName(a) {
  const key = String(a.serial || a.assetTag || a.id).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
  const date = a.completedAt ? new Date(a.completedAt).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-') : 'undated';
  return `${key}_${date}.pdf`;
}

module.exports = { renderRecordPdf, pdfName, pdfText };
