'use strict';

// Runs the real server against a real PostgreSQL. Needs an empty test
// database: HUB_TEST_DATABASE_URL=postgres://... npm test
// Skipped when that isn't set (e.g. on a laptop without PostgreSQL).

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const URL_ = process.env.HUB_TEST_DATABASE_URL;
const skip = !URL_ && 'set HUB_TEST_DATABASE_URL to run';

const { createPool, migrate } = require('../src/db');
const { buildApp } = require('../src/server');
const { fileStore } = require('../src/store');
const { newKey } = require('../src/keys');
const { hashPassword } = require('../src/passwords');

const record = (over = {}) => ({
  schema: 'qudit.audit',
  schemaVersion: 1,
  id: crypto.randomUUID(),
  serial: 'SN-0001',
  profile: 'intake',
  overall: 'pass',
  completedAt: new Date().toISOString(),
  app: { version: '2.5.0-beta.1' },
  hardware: { system: { manufacturer: 'Dell Inc.', model: 'Latitude 5420' }, intake: { mdm: { status: 'clean' }, malware: { status: 'clean' } } },
  tests: { mdm: { status: 'pass' }, malware: { status: 'pass' } },
  ...over,
});

test('Hub against PostgreSQL', { skip }, async (t) => {
  const pool = createPool(URL_);
  // Fresh schema every run.
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-files-'));
  const config = { filesDir, secureCookies: false, sessionHours: 12, maxUploadMb: 5, trustProxy: false };
  const app = buildApp({ pool, config, files: fileStore(filesDir), logger: false });

  const [dal, phx] = (await pool.query("INSERT INTO sites (code, name) VALUES ('DAL', 'Dallas'), ('PHX', 'Phoenix') RETURNING id")).rows.map((r) => r.id);
  const station = newKey('station');
  await pool.query("INSERT INTO stations (site_id, name, key_prefix, key_hash) VALUES ($1, 'Bench 1', $2, $3)", [dal, station.prefix, station.hash]);
  const phxStation = newKey('station');
  await pool.query("INSERT INTO stations (site_id, name, key_prefix, key_hash) VALUES ($1, 'Bench 1', $2, $3)", [phx, phxStation.prefix, phxStation.hash]);
  await pool.query("INSERT INTO users (username, password_hash, role, all_sites) VALUES ('admin', $1, 'admin', true)", [await hashPassword('a very long password')]);

  const as = (key) => ({ authorization: `Bearer ${key}` });
  const upload = (body, key = station.key) => app.inject({ method: 'POST', url: '/api/v1/audits', headers: as(key), payload: body });

  await t.test('station uploads are idempotent; a different record with the same id is refused', async () => {
    const r = record();
    assert.equal((await upload({ record: r })).statusCode, 201);
    const again = await upload({ record: r });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().status, 'duplicate');
    assert.equal((await upload({ record: { ...r, overall: 'fail' } })).statusCode, 409);
  });

  await t.test('bad input and bad keys are rejected', async () => {
    assert.equal((await upload({ record: { ...record(), id: 'nope' } })).statusCode, 400);
    assert.equal((await upload({ record: record(), extra: 1 })).statusCode, 400);
    assert.equal((await upload({ record: record() }, 'bws_' + 'x'.repeat(43))).statusCode, 401);
    assert.equal((await upload({ record: record(), pdf: Buffer.from('<html>').toString('base64') })).statusCode, 400);
    await pool.query('UPDATE stations SET revoked_at = now() WHERE key_hash = $1', [phxStation.hash]);
    assert.equal((await upload({ record: record() }, phxStation.key)).statusCode, 401, 'revoked');
    await pool.query('UPDATE stations SET revoked_at = NULL WHERE key_hash = $1', [phxStation.hash]);
  });

  await t.test('PDFs are stored once and served back', async () => {
    const pdf = Buffer.from('%PDF-1.7\nhello\n%%EOF');
    const r = record({ serial: 'SN-PDF' });
    assert.equal((await upload({ record: r, pdf: pdf.toString('base64') })).statusCode, 201);
    const client = newKey('client');
    await pool.query("INSERT INTO api_clients (name, key_prefix, key_hash) VALUES ('wms', $1, $2)", [client.prefix, client.hash]);
    const res = await app.inject({ url: `/api/v1/audits/${r.id}/pdf`, headers: as(client.key) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.deepEqual(res.rawPayload, pdf);
  });

  await t.test('integration keys: search, incremental export by cursor, unit history, site limits', async () => {
    await upload({ record: record({ serial: 'SN-PHX' }) }, phxStation.key);
    const all = newKey('client');
    await pool.query("INSERT INTO api_clients (name, key_prefix, key_hash) VALUES ('tableau', $1, $2)", [all.prefix, all.hash]);
    const dalOnly = newKey('client');
    await pool.query("INSERT INTO api_clients (name, key_prefix, key_hash, site_ids) VALUES ('dal-wms', $1, $2, $3)", [dalOnly.prefix, dalOnly.hash, [dal]]);

    const first = (await app.inject({ url: '/api/v1/audits?since=0&limit=2', headers: as(all.key) })).json();
    assert.equal(first.items.length, 2);
    const next = (await app.inject({ url: `/api/v1/audits?since=${first.nextCursor}&limit=500`, headers: as(all.key) })).json();
    assert.ok(next.items.every((i) => Number(i.cursor) > Number(first.nextCursor)), 'only newer records');

    const dalView = (await app.inject({ url: '/api/v1/audits?limit=500', headers: as(dalOnly.key) })).json();
    assert.ok(dalView.items.length > 0 && dalView.items.every((i) => i.site === 'DAL'), 'a DAL-only key never sees PHX');
    const phxRecord = (await app.inject({ url: '/api/v1/audits?serial=SN-PHX', headers: as(all.key) })).json().items[0];
    assert.equal((await app.inject({ url: `/api/v1/audits/${phxRecord.id}`, headers: as(dalOnly.key) })).statusCode, 404);

    const unit = (await app.inject({ url: '/api/v1/units/sn-0001', headers: as(all.key) })).json();
    assert.equal(unit.latest.serial, 'SN-0001');
    assert.equal(unit.latest.mdm, 'clean');
    assert.equal((await app.inject({ url: '/api/v1/audits', headers: as(station.key) })).statusCode, 401, 'station keys cannot read');
  });

  await t.test('CSV export is safe from spreadsheet formula injection', async () => {
    await upload({ record: record({ serial: '=HYPERLINK("http://evil")', technician: '@SUM(1)' }) });
    const client = newKey('client');
    await pool.query("INSERT INTO api_clients (name, key_prefix, key_hash) VALUES ('csv', $1, $2)", [client.prefix, client.hash]);
    const csv = (await app.inject({ url: '/api/v1/audits.csv', headers: as(client.key) })).payload;
    assert.match(csv, /"'=HYPERLINK\(""http:\/\/evil""\)"/);
    assert.match(csv, /'@SUM\(1\)/);
  });

  await t.test('staff: sign in, CSRF header required for changes, keys shown once, admin log', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/session', payload: { username: 'admin', password: 'wrong password!!' } })).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/v1/session', payload: { username: 'admin', password: 'a very long password' } });
    assert.equal(login.statusCode, 200);
    const cookie = login.headers['set-cookie'].split(';')[0];
    assert.match(login.headers['set-cookie'], /HttpOnly; SameSite=Strict/);

    const body = { site: 'DAL', name: 'Bench 2' };
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/stations', headers: { cookie }, payload: body })).statusCode, 403, 'no X-Benchwise header');
    const made = await app.inject({ method: 'POST', url: '/api/v1/stations', headers: { cookie, 'x-benchwise': '1' }, payload: body });
    assert.equal(made.statusCode, 201);
    assert.match(made.json().key, /^bws_/);
    const listed = (await app.inject({ url: '/api/v1/stations', headers: { cookie } })).json();
    assert.ok(!JSON.stringify(listed).includes(made.json().key), 'the key is never listed again');
    const logRows = (await app.inject({ url: '/api/v1/admin-log', headers: { cookie } })).json();
    assert.equal(logRows[0].action, 'station.create');

    const weak = await app.inject({ method: 'POST', url: '/api/v1/users', headers: { cookie, 'x-benchwise': '1' }, payload: { username: 'bob', password: 'short', role: 'viewer' } });
    assert.equal(weak.statusCode, 400);
    await app.inject({ method: 'DELETE', url: '/api/v1/session', headers: { cookie } });
    assert.equal((await app.inject({ url: '/api/v1/me', headers: { cookie } })).statusCode, 401, 'signed out');
  });

  await t.test('sign-in is rate limited', async () => {
    let last;
    for (let i = 0; i < 9; i++) last = await app.inject({ method: 'POST', url: '/api/v1/session', payload: { username: 'victim', password: 'guess guess guess' } });
    assert.equal(last.statusCode, 429);
  });

  await t.test('audits are append-only and the chain exposes tampering', async () => {
    await assert.rejects(pool.query("UPDATE audits SET overall = 'pass'"), /append-only/);
    await assert.rejects(pool.query('DELETE FROM audits'), /append-only/);
    const ok = (await pool.query('SELECT id FROM sites WHERE code = $1', ['DAL'])).rows[0].id;
    const { verifyChain } = require('../src/store');
    assert.equal((await verifyChain(pool, ok)).ok, true);
    // Simulate an attacker with database owner rights who bypasses the trigger.
    await pool.query('ALTER TABLE audits DISABLE TRIGGER audits_append_only');
    // e.g. quietly turning a unit's result from pass into fail
    await pool.query(`UPDATE audits SET record = jsonb_set(record, '{overall}', '"fail"') WHERE serial = 'SN-PDF'`);
    await pool.query('ALTER TABLE audits ENABLE TRIGGER audits_append_only');
    const v = await verifyChain(pool, ok);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'record changed');
  });

  await t.test('security headers and health', async () => {
    const res = await app.inject({ url: '/healthz' });
    assert.equal(res.json().ok, true);
    assert.match(res.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(res.headers['x-frame-options'], 'DENY');
  });

  await app.close();
  await pool.end();
});
