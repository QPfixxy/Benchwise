'use strict';

// Runs the real server against a real PostgreSQL. Needs an empty test
// database: BW_TEST_DATABASE_URL=postgres://... npm test
// Skipped when that isn't set (e.g. on a laptop without PostgreSQL).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const URL_ = process.env.BW_TEST_DATABASE_URL;
const skip = !URL_ && 'set BW_TEST_DATABASE_URL to run';

const { createPool, migrate } = require('../src/db');
const { buildApp } = require('../src/server');
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
  const config = { secureCookies: false, sessionHours: 12, maxUploadMb: 5, trustProxy: false };
  const app = buildApp({ pool, config, logger: false });

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
    assert.equal((await upload({ record: record(), pdf: 'JVBERi0=' })).statusCode, 400, 'servers take records only, no PDFs');
    await pool.query('UPDATE stations SET revoked_at = now() WHERE key_hash = $1', [phxStation.hash]);
    assert.equal((await upload({ record: record() }, phxStation.key)).statusCode, 401, 'revoked');
    await pool.query('UPDATE stations SET revoked_at = NULL WHERE key_hash = $1', [phxStation.hash]);
  });

  await t.test('full records land in their yearly partition; search stays on the narrow table', async () => {
    const r = record({ serial: 'SN-2025', completedAt: '2025-06-30T23:59:59Z' });
    assert.equal((await upload({ record: r })).statusCode, 201);
    const where = await pool.query('SELECT tableoid::regclass AS part FROM audit_records WHERE audit_id = $1', [r.id]);
    assert.equal(String(where.rows[0].part), 'audit_records_2025');
    const old = record({ serial: 'SN-1999', completedAt: '1999-01-01T00:00:00Z' });
    assert.equal((await upload({ record: old })).statusCode, 201, 'outside the created years: the default partition');
    assert.equal(String((await pool.query('SELECT tableoid::regclass AS p FROM audit_records WHERE audit_id = $1', [old.id])).rows[0].p), 'audit_records_other');
    const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'audits'")).rows.map((c) => c.column_name);
    assert.ok(!cols.includes('record'), 'the search table holds no full records');
  });

  await t.test('floor side: only station endpoints; staff side: no station uploads', async () => {
    const floorApp = buildApp({ pool, config, side: 'floor', logger: false });
    const staffApp = buildApp({ pool, config, side: 'staff', logger: false });
    assert.equal((await floorApp.inject({ method: 'POST', url: '/api/v1/audits', headers: as(station.key), payload: { record: record() } })).statusCode, 201);
    for (const url of ['/', '/api/v1/audits', '/api/v1/me', '/api/v1/stations']) assert.equal((await floorApp.inject({ url })).statusCode, 404, `floor ${url}`);
    assert.equal((await staffApp.inject({ method: 'POST', url: '/api/v1/audits', headers: as(station.key), payload: { record: record() } })).statusCode, 404, 'staff side takes no uploads');
    assert.equal((await staffApp.inject({ url: '/' })).statusCode, 200);
    await floorApp.close();
    await staffApp.close();
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
    await assert.rejects(pool.query("UPDATE audit_records SET record = '{}'"), /append-only/);
    await assert.rejects(pool.query('DELETE FROM audit_records'), /append-only/);
    const ok = (await pool.query('SELECT id FROM sites WHERE code = $1', ['DAL'])).rows[0].id;
    const { verifyChain } = require('../src/store');
    const intact = await verifyChain(pool, ok, { batch: 2 }); // small batches: exercises the paging
    assert.equal(intact.ok, true);
    assert.ok(intact.checked > 4);
    // Simulate an attacker with database owner rights who bypasses the trigger.
    await pool.query('ALTER TABLE audits DISABLE TRIGGER audits_append_only');
    // e.g. quietly turning a unit's result from pass into fail
    await pool.query('ALTER TABLE audit_records DISABLE TRIGGER audit_records_append_only');
    await pool.query(`UPDATE audit_records SET record = jsonb_set(record, '{overall}', '"fail"') WHERE record->>'serial' = 'SN-2025'`);
    await pool.query('ALTER TABLE audit_records ENABLE TRIGGER audit_records_append_only');
    await pool.query('ALTER TABLE audits ENABLE TRIGGER audits_append_only');
    const v = await verifyChain(pool, ok, { batch: 2 });
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
