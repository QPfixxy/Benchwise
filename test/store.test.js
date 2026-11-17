'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReportStore, buildAudit } = require('../src/main/reports/store');
const { renderReportHtml } = require('../src/main/reports/template');

const settings = {
  assetTagPattern: '',
  assetTagLabel: 'Asset Tag',
  stationName: 'Bench 1',
  enabledTests: { camera: true, keyboard: true, touchscreen: false },
};
const app = { name: 'Benchwise', version: 'test', platform: 'test' };
const hardware = { system: { serial: 'SER123', manufacturer: 'Acme', model: '<b>X1</b>' }, storage: [], warnings: [] };

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchwise-test-'));
  return { dir, store: new ReportStore(() => dir, async () => Buffer.from('%PDF-fake')) };
}

test('buildAudit keeps only enabled tests, drops UI-only fields, computes overall', () => {
  const a = buildAudit({
    input: {
      assetTag: 'TAG-1',
      tests: {
        camera: { status: 'pass', details: { resolution: '1280×720', _internal: [1, 2] } },
        keyboard: { status: 'bogus' },
        touchscreen: { status: 'fail' }, // disabled: must not appear
      },
    },
    hardware,
    settings,
    app,
  });
  assert.deepEqual(Object.keys(a.tests), ['camera', 'keyboard']);
  assert.equal(a.tests.keyboard.status, 'untested');
  assert.equal(a.tests.camera.details._internal, undefined);
  assert.equal(a.overall, 'incomplete');
  assert.equal(a.schemaVersion, 1);
});

test('buildAudit rejects unsafe asset tags', () => {
  assert.throws(() => buildAudit({ input: { assetTag: '../x' }, hardware, settings, app }));
});

test('reports are never overwritten and are listed newest first', async () => {
  const { store } = tmpStore();
  const mk = () => buildAudit({ input: { assetTag: 'SAME', tests: {} }, hardware, settings, app });
  const a = mk();
  const b = { ...mk(), completedAt: a.completedAt }; // same second -> same base name
  const r1 = await store.save(a);
  const r2 = await store.save(b);
  assert.notEqual(r1.file, r2.file);
  const list = await store.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].hasPdf, true);
});

test('resolve() refuses anything outside the reports folder', () => {
  const { store, dir } = tmpStore();
  assert.throws(() => store.resolve('../secret', 'json'));
  assert.throws(() => store.resolve('a/b', 'json'));
  assert.throws(() => store.resolve('ok', 'exe'));
  assert.equal(store.resolve('TAG_20260101-000000', 'pdf'), path.join(dir, 'TAG_20260101-000000.pdf'));
});

test('PDF template escapes hardware strings', async () => {
  const a = buildAudit({ input: { assetTag: 'TAG-2', notes: '<script>x</script>', tests: {} }, hardware, settings, app });
  const html = await renderReportHtml(a);
  assert.ok(!html.includes('<b>X1</b>'));
  assert.ok(html.includes('&lt;b&gt;X1&lt;/b&gt;'));
  assert.ok(!html.includes('<script>x'));
  assert.ok(html.includes('<svg')); // QR generated locally
});

test('PDF shows the Drive Health section and prefers it for the storage SMART column', async () => {
  const hw = {
    ...hardware,
    storage: [{ model: 'Disk', serial: 'SN 1', smartStatus: 'Unknown' }],
    driveHealth: {
      ok: true,
      drives: [
        { model: '<i>Evil</i>', serial: 'SN1', status: 'fail', lifeRemaining: 40, powerOnHours: 12000, checks: [{ label: 'Pending sectors', value: 16, status: 'fail' }] },
        { model: 'Stick', status: 'unknown', external: true, checks: [], reason: 'External drive' },
      ],
    },
  };
  const a = buildAudit({ input: { assetTag: 'TAG-3', tests: {} }, hardware: hw, settings, app });
  const html = await renderReportHtml(a);
  assert.ok(html.includes('<h2>Drive health</h2>'));
  assert.ok(html.includes('&lt;i&gt;Evil&lt;/i&gt;') && !html.includes('<i>Evil'));
  assert.ok(html.includes('Pending sectors: 16'));
  assert.ok(html.includes('External, not counted'));
  assert.ok(html.includes('<td>FAILING</td>'), 'storage row takes the Drive Health status by serial');

  const plain = await renderReportHtml(buildAudit({ input: { assetTag: 'TAG-4', tests: {} }, hardware, settings, app }));
  assert.ok(!plain.includes('Drive health'), 'no section when the test was not run');
});
