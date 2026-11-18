'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Outbox, RETRY_MIN_MS } = require('../src/main/hub/outbox');
const { hubRequest, validFingerprint } = require('../src/main/hub/client');
const { hubConfig } = require('../src/main/settings');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bw-outbox-'));
const rec = (id = crypto.randomUUID()) => ({ schema: 'qudit.audit', schemaVersion: 1, id, completedAt: new Date().toISOString(), tests: {} });

function harness(responses, { configured = true } = {}) {
  const dir = tmp();
  const sent = [];
  const timers = [];
  const box = new Outbox({
    dir,
    config: () => (configured ? { url: 'https://hub', key: 'bws_x' } : null),
    send: async (_cfg, body) => {
      sent.push(body);
      const r = responses.shift();
      if (r instanceof Error) throw r;
      return r;
    },
    setTimer: (fn, ms) => (timers.push(ms), { unref() {} }),
    clearTimer: () => {},
  });
  const ls = (sub) => (fs.existsSync(path.join(dir, sub)) ? fs.readdirSync(path.join(dir, sub)).sort() : []);
  return { box, sent, timers, ls, dir };
}

test('outbox: queued reports are sent and moved to sent/; the PDF travels too', async () => {
  const h = harness([{ status: 201 }, { status: 200 }]);
  const a = rec();
  await h.box.enqueue(a, Buffer.from('%PDF-1.7'));
  await h.box.flush();
  await h.box.enqueue(rec());
  await h.box.flush();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[0].record.id, a.id);
  assert.equal(Buffer.from(h.sent[0].pdf, 'base64').toString(), '%PDF-1.7');
  assert.equal(h.sent[1].pdf, undefined);
  assert.deepEqual(h.ls('pending'), []);
  assert.equal(h.ls('sent').length, 2);
  assert.ok((await h.box.status()).sentAt);
});

test('outbox: offline means keep and retry with growing back-off; nothing is lost', async () => {
  const h = harness([new Error('ECONNREFUSED'), new Error('ECONNREFUSED'), { status: 201 }]);
  const a = rec();
  await h.box.enqueue(a);
  await h.box.flush();
  await h.box.flush();
  assert.deepEqual(h.timers.slice(-2), [RETRY_MIN_MS, RETRY_MIN_MS * 2], 'back-off doubles');
  assert.deepEqual(h.ls('pending'), [`${a.id}.json`], 'still queued');
  const st = await h.box.status();
  assert.match(st.error, /unreachable/);
  assert.ok(st.nextAttemptAt);
  await h.box.flush();
  assert.deepEqual(h.ls('sent'), [`${a.id}.json`]);
});

test('outbox: a refused report is parked with the reason, and the rest still go', async () => {
  const h = harness([{ status: 409, json: { error: 'A different record with this id already exists.' } }, { status: 201 }]);
  const bad = rec();
  await h.box.enqueue(bad);
  await new Promise((r) => setTimeout(r, 5)); // distinct file times: oldest first
  await h.box.enqueue(rec());
  await h.box.flush();
  assert.equal(h.ls('pending').length, 0);
  assert.deepEqual(h.ls('failed'), [`${bad.id}.json`, `${bad.id}.reason.txt`]);
  assert.match(fs.readFileSync(path.join(h.dir, 'failed', `${bad.id}.reason.txt`), 'utf8'), /^409: A different record/);
  assert.equal(h.ls('sent').length, 1);
});

test('outbox: a rejected key stops the run (retry later); no Hub configured means nothing is sent', async () => {
  const h = harness([{ status: 401 }]);
  await h.box.enqueue(rec());
  await h.box.flush();
  assert.equal(h.ls('pending').length, 1);
  assert.match((await h.box.status()).error, /rejected this station key/);

  const off = harness([], { configured: false });
  await off.box.enqueue(rec());
  await off.box.flush();
  assert.equal(off.sent.length, 0);
  assert.equal((await off.box.status()).configured, false);
});

test('hub config: Settings, with site.cmd (environment) winning; both address and key needed', () => {
  assert.equal(hubConfig({ hubUrl: 'https://a', hubKey: '' }, {}), null);
  assert.deepEqual(hubConfig({ hubUrl: 'https://a', hubKey: 'k', hubFingerprint: '' }, {}), { url: 'https://a', key: 'k', fingerprint: null, fromEnv: false });
  const env = hubConfig({ hubUrl: 'https://a', hubKey: 'k' }, { BENCHWISE_HUB_URL: 'https://b', BENCHWISE_HUB_KEY: 'k2', BENCHWISE_HUB_FINGERPRINT: 'AA' });
  assert.deepEqual(env, { url: 'https://b', key: 'k2', fingerprint: 'AA', fromEnv: true });
  assert.equal(validFingerprint('41:69:E0:E8:57:96:AD:6B:AC:BE:13:5D:9D:A0:92:A7:99:D5:60:76:F4:77:E7:8D:A6:9B:54:99:CC:42:DD:3C'), true);
  assert.equal(validFingerprint('41:69'), false);
});

// A real TLS server with a throwaway self-signed certificate (needs openssl).
let openssl = true;
try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' });
} catch {
  openssl = false;
}

test('pinned TLS: the right fingerprint connects; a wrong one is refused before the key is sent', { skip: !openssl && 'openssl not available' }, async () => {
  const dir = tmp();
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  const cert = fs.readFileSync(path.join(dir, 'c.pem'));
  const fingerprint = new crypto.X509Certificate(cert).fingerprint256;
  const seen = [];
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert }, (req, res) => {
    seen.push(req.headers.authorization);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, path: req.url, got: body ? JSON.parse(body) : null })));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `https://127.0.0.1:${server.address().port}`;
  try {
    const ok = await hubRequest({ url, key: 'bws_secret', fingerprint, method: 'POST', path: '/api/v1/audits', body: { a: 1 } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { ok: true, path: '/api/v1/audits', got: { a: 1 } });
    assert.deepEqual(seen, ['Bearer bws_secret']);

    const wrong = fingerprint.replace(/^[0-9A-F]{2}/, (h) => (h === '00' ? '11' : '00'));
    await assert.rejects(hubRequest({ url, key: 'bws_secret', fingerprint: wrong, path: '/api/v1/station' }), { code: 'CERT_MISMATCH' });
    assert.equal(seen.length, 1, 'the key never reached the server on a mismatch');
    await assert.rejects(hubRequest({ url: url.replace('https', 'http'), key: 'k', path: '/' }), /https/);
  } finally {
    server.close();
  }
});
