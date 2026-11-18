'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalJson, sha256, chainHash, validateRecord, extractFields } = require('../src/records');
const { newKey, hashKey, bearer } = require('../src/keys');
const { hashPassword, verifyPassword, checkStrength } = require('../src/passwords');
const { rateLimiter, parseCookies, sessionCookie } = require('../src/auth');
const { loadConfig } = require('../src/config');

// The shape Benchwise saves (trimmed).
const RECORD = {
  schema: 'qudit.audit',
  schemaVersion: 1,
  id: '0b6f8e2c-3c1a-4d2e-9f00-1234567890ab',
  assetTag: null,
  serial: 'M80-C8008700942',
  uuid: 'a2bef606-2a0b-44e7-b09b-eb0889727f2a',
  profile: 'intake',
  technician: 'T12',
  completedAt: '2026-11-18T16:38:55.954Z',
  app: { version: '2.5.0-beta.1' },
  overall: 'pass',
  hardware: {
    system: { manufacturer: 'Dell Inc.', model: 'Latitude 5420', serial: 'M80-C8008700942' },
    intake: { mdm: { status: 'clean' }, malware: { status: 'infected' } },
  },
  tests: { mdm: { status: 'pass' }, malware: { status: 'pass', details: { result: 'infected' } } },
};

test('canonical JSON: key order never changes the hash', () => {
  const a = { b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } };
  const b = { a: { c: null, d: [3, { x: 2, y: 1 }] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
});

test('hash chain: each link depends on the previous one', () => {
  const r1 = sha256('one');
  const r2 = sha256('two');
  const h1 = chainHash(null, r1);
  const h2 = chainHash(h1, r2);
  assert.notEqual(chainHash(null, r2), h2, 'same record, different position, different hash');
  assert.equal(chainHash(h1, r2), h2, 'deterministic');
  assert.match(h2, /^[0-9a-f]{64}$/);
});

test('record validation', () => {
  assert.equal(validateRecord(RECORD), null);
  assert.match(validateRecord({ ...RECORD, schema: 'other' }), /schema/);
  assert.match(validateRecord({ ...RECORD, id: 'not-a-uuid' }), /UUID/);
  assert.match(validateRecord({ ...RECORD, completedAt: 'yesterday' }), /date/);
  assert.match(validateRecord({ ...RECORD, schemaVersion: 0 }), /schemaVersion/);
  assert.match(validateRecord([]), /object/);
});

test('searchable fields are copied out of a Benchwise record', () => {
  assert.deepEqual(extractFields(RECORD), {
    serial: 'M80-C8008700942',
    uuid: 'a2bef606-2a0b-44e7-b09b-eb0889727f2a',
    assetTag: null,
    manufacturer: 'Dell Inc.',
    model: 'Latitude 5420',
    profile: 'intake',
    overall: 'pass',
    mdmStatus: 'clean',
    malwareStatus: 'infected',
    technician: 'T12',
    completedAt: '2026-11-18T16:38:55.954Z',
    appVersion: '2.5.0-beta.1',
  });
  // Older (2.4) records: no top-level serial or profile, no intake section.
  const old = extractFields({ ...RECORD, serial: undefined, profile: undefined, hardware: { system: { serial: 'OLD1' } }, tests: { mdm: { status: 'na' } } });
  assert.deepEqual([old.serial, old.profile, old.mdmStatus, old.malwareStatus], ['OLD1', 'full', 'na', null]);
});

test('keys: shown once, stored as a hash, recognised by kind', () => {
  const s = newKey('station');
  assert.match(s.key, /^bws_[A-Za-z0-9_-]{43}$/);
  assert.equal(s.prefix, s.key.slice(0, 12));
  assert.deepEqual(s.hash, hashKey(s.key));
  assert.notDeepEqual(newKey('station').hash, s.hash);
  assert.equal(bearer(`Bearer ${s.key}`, 'station'), s.key);
  assert.equal(bearer(`Bearer ${s.key}`, 'client'), null, 'a station key is not an integration key');
  assert.equal(bearer('Bearer bws_short', 'station'), null);
  assert.equal(bearer(s.key, 'station'), null, 'needs the Bearer scheme');
});

test('passwords: scrypt, verify, strength', async () => {
  const h = await hashPassword('correct horse battery');
  assert.match(h, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword('correct horse battery', h), true);
  assert.equal(await verifyPassword('wrong horse battery!', h), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
  assert.match(checkStrength('short'), /12/);
  assert.equal(checkStrength('a long enough passphrase'), null);
});

test('rate limiter: only counts hits; blocks within the window, then resets', () => {
  let t = 0;
  const rl = rateLimiter({ max: 2, windowMs: 1000, now: () => t });
  assert.equal(rl.blocked('ip'), false);
  assert.equal(rl.hit('ip'), true);
  assert.equal(rl.hit('ip'), true);
  assert.equal(rl.blocked('ip'), true);
  assert.equal(rl.hit('ip'), false);
  t = 1500;
  assert.equal(rl.blocked('ip'), false);
});

test('cookies and config', () => {
  assert.deepEqual(parseCookies('a=1; bw_session=bwx_abc%3D; b=2'), { a: '1', bw_session: 'bwx_abc=', b: '2' });
  const c = sessionCookie('bwx_t', { hours: 12 });
  for (const part of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/', 'Max-Age=43200']) assert.ok(c.includes(part), part);
  const cfg = loadConfig({ BW_LISTEN: '0.0.0.0:9000', BW_SESSION_HOURS: '1000' });
  assert.deepEqual([cfg.host, cfg.port, cfg.sessionHours, cfg.secureCookies], ['0.0.0.0', 9000, 168, true]);
});
