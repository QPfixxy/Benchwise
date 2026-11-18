'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const setup = require('../src/setup');
const { applyRequest, readRequest } = require('../src/apply');

const IFACES = [
  { name: 'eth0', address: '10.1.0.20', cidr: '10.1.0.20/24' },
  { name: 'eth1', address: '172.16.0.2', cidr: '172.16.0.2/24' },
];

const GOOD = {
  site: { code: 'dal', name: 'Dallas', timeZone: 'America/Chicago' },
  network: { mode: 'two', companyIp: '10.1.0.20', floorIp: '172.16.0.2' },
  certificate: { mode: 'generated' },
  wifi: { ssid: 'FLOOR', password: 'floor-pass-123' },
  admin: { username: 'alice', password: 'a long enough passphrase', confirm: 'a long enough passphrase' },
};

test('setup codes: readable alphabet, forgiving input, stored only as a hash', () => {
  const c = setup.newSetupCode();
  assert.match(c, /^[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/);
  assert.equal(setup.hashCode(c), setup.hashCode(` ${c.toLowerCase().replace('-', ' ')} `), 'case, spaces and dashes ignored');
  assert.notEqual(setup.hashCode(c), setup.hashCode(setup.newSetupCode()));
  assert.match(setup.hashCode(c), /^[0-9a-f]{64}$/);
});

test('interfaces: IPv4, not loopback', () => {
  const list = setup.localInterfaces({ lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }], eth0: [{ family: 'IPv4', address: '10.1.0.20', internal: false, cidr: '10.1.0.20/24' }, { family: 'IPv6', address: 'fe80::1', internal: false }] });
  assert.deepEqual(list, [{ name: 'eth0', address: '10.1.0.20', cidr: '10.1.0.20/24' }]);
});

test('wizard validation: a good submission becomes a plan', () => {
  const { errors, plan } = setup.checkSetup(GOOD, { interfaces: IFACES });
  assert.equal(errors, undefined);
  assert.equal(plan.site.code, 'DAL');
  assert.deepEqual(plan.network, { mode: 'two', companyIp: '10.1.0.20', floorIp: '172.16.0.2' });
  assert.deepEqual(plan.wifi, { ssid: 'FLOOR', password: 'floor-pass-123' });
});

test('wizard validation: networks must be this machine, different, and well-formed', () => {
  const bad = (network) => setup.checkSetup({ ...GOOD, network }, { interfaces: IFACES }).errors || [];
  assert.match(bad({ mode: 'two', companyIp: '10.1.0.20', floorIp: '8.8.8.8' }).join(' '), /8\.8\.8\.8 is not an address of this server/);
  assert.match(bad({ mode: 'two', companyIp: '10.1.0.20', floorIp: '10.1.0.20' }).join(' '), /must be different/);
  assert.match(bad({ mode: 'two', companyIp: '10.1.0.20; rm -rf /', floorIp: '172.16.0.2' }).join(' '), /Choose the company network card/);
  assert.match(bad({ mode: 'three' }).join(' '), /one network or two/);
  assert.deepEqual(bad({ mode: 'one' }), []);
});

test('wizard validation: facility, Wi-Fi and admin rules', () => {
  const errs = setup.checkSetup({ ...GOOD, site: { code: 'd', name: '', timeZone: 'Mars/Base' }, wifi: { ssid: 'X', password: 'short' }, admin: { username: 'Al', password: 'short', confirm: 'other' } }, { interfaces: IFACES }).errors.join(' | ');
  for (const re of [/Facility code/, /Facility name/, /time zone/, /Wi-Fi password/, /Admin username/, /Admin password/, /don't match/]) assert.match(errs, re);
});

// A throwaway certificate (needs openssl).
let openssl = true;
try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' });
} catch {
  openssl = false;
}
function makeCert(dir, name) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', `/CN=${name}`, '-keyout', path.join(dir, `${name}.key`), '-out', path.join(dir, `${name}.crt`)], { stdio: 'ignore' });
  return { certPem: fs.readFileSync(path.join(dir, `${name}.crt`), 'utf8'), keyPem: fs.readFileSync(path.join(dir, `${name}.key`), 'utf8') };
}

test('certificate upload: must parse and the key must belong to the certificate', { skip: !openssl && 'openssl not available' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-cert-'));
  const a = makeCert(dir, 'a');
  const b = makeCert(dir, 'b');
  const ok = setup.checkCertificate({ mode: 'upload', ...a });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.fingerprint, new crypto.X509Certificate(a.certPem).fingerprint256);
  assert.match(setup.checkCertificate({ mode: 'upload', certPem: a.certPem, keyPem: b.keyPem }).errors.join(), /doesn't belong/);
  assert.match(setup.checkCertificate({ mode: 'upload', certPem: '-----BEGIN CERTIFICATE-----\ngarbage', keyPem: a.keyPem }).errors.join(), /couldn't be read/);
  assert.match(setup.checkCertificate({ mode: 'upload', ...a }, { now: new Date(Date.now() + 10 * 86400e3) }).errors.join(), /expired/);
});

// ---------------------------------------------------------------- the root helper, in a fake /etc

function fakeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-apply-'));
  const paths = {
    etc: path.join(root, 'etc'),
    templates: path.join(root, 'templates'),
    nginxSite: path.join(root, 'nginx-site'),
    sysctl: path.join(root, 'sysctl.conf'),
  };
  fs.mkdirSync(path.join(paths.etc, 'tls'), { recursive: true });
  fs.mkdirSync(paths.templates);
  for (const f of ['nginx.conf', 'nginx-two-networks.conf']) fs.copyFileSync(path.join(__dirname, '..', 'deploy', f), path.join(paths.templates, f));
  fs.writeFileSync(path.join(paths.etc, 'server.env'), 'BW_DATABASE_URL=postgres://x\nBW_LISTEN=127.0.0.1:8080\n');
  fs.writeFileSync(paths.nginxSite, 'ORIGINAL NGINX');
  return paths;
}

test('apply helper: two networks -> nginx bound to both sides, floor listener on, forwarding off', () => {
  const paths = fakeRoot();
  const ran = [];
  const res = applyRequest({ network: GOOD.network, certificate: { mode: 'generated' } }, { paths, interfaces: IFACES, run: (c, a) => ran.push([c, ...a].join(' ')) });
  assert.equal(res.url, 'https://10.1.0.20/');
  const site = fs.readFileSync(paths.nginxSite, 'utf8');
  assert.match(site, /listen 10\.1\.0\.20:443 ssl;/);
  assert.match(site, /listen 172\.16\.0\.2:443 ssl;/);
  assert.doesNotMatch(site, /__COMPANY_IP__|__FLOOR_IP__/);
  assert.match(fs.readFileSync(path.join(paths.etc, 'server.env'), 'utf8'), /^BW_FLOOR_LISTEN=127\.0\.0\.1:8081$/m);
  assert.match(fs.readFileSync(paths.sysctl, 'utf8'), /ip_forward = 0/);
  assert.deepEqual(ran, ['nginx -t -q', 'sysctl -q --system', 'systemctl restart benchwise-server', 'systemctl restart nginx']);

  // Back to one network: floor listener and the forwarding override go away.
  applyRequest({ network: { mode: 'one' }, certificate: { mode: 'generated' } }, { paths, interfaces: IFACES, run: () => {} });
  assert.doesNotMatch(fs.readFileSync(path.join(paths.etc, 'server.env'), 'utf8'), /BW_FLOOR_LISTEN/);
  assert.equal(fs.existsSync(paths.sysctl), false);
});

test('apply helper: refuses addresses that are not this machine; puts everything back if nginx says no', () => {
  const paths = fakeRoot();
  assert.throws(() => applyRequest({ network: { mode: 'two', companyIp: '10.1.0.20', floorIp: '192.0.2.1' }, certificate: { mode: 'generated' } }, { paths, interfaces: IFACES, run: () => {} }), /not an address of this server/);
  assert.equal(fs.readFileSync(paths.nginxSite, 'utf8'), 'ORIGINAL NGINX', 'nothing touched');

  const nginxFails = (cmd) => {
    if (cmd === 'nginx') throw Object.assign(new Error('nginx failed'), { stderr: 'emerg: bad config' });
  };
  assert.throws(() => applyRequest({ network: GOOD.network, certificate: { mode: 'generated' } }, { paths, interfaces: IFACES, run: nginxFails }), /previous settings kept: emerg: bad config/);
  assert.equal(fs.readFileSync(paths.nginxSite, 'utf8'), 'ORIGINAL NGINX', 'nginx config restored');
  assert.doesNotMatch(fs.readFileSync(path.join(paths.etc, 'server.env'), 'utf8'), /BW_FLOOR_LISTEN/, 'service settings restored');
  assert.equal(fs.existsSync(paths.sysctl), false);
});

test('apply helper: an uploaded certificate is installed (key owner-only)', { skip: !openssl && 'openssl not available' }, () => {
  const paths = fakeRoot();
  const c = makeCert(fs.mkdtempSync(path.join(os.tmpdir(), 'bw-cert-')), 'company');
  applyRequest({ network: { mode: 'one' }, certificate: { mode: 'upload', ...c } }, { paths, interfaces: IFACES, run: () => {} });
  assert.equal(fs.readFileSync(path.join(paths.etc, 'tls', 'server.crt'), 'utf8'), c.certPem);
  assert.equal(fs.statSync(path.join(paths.etc, 'tls', 'server.key')).mode & 0o777, 0o600);
});

test('apply helper: request files are read without following links', { skip: process.platform === 'win32' && 'POSIX only' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-inbox-'));
  const secret = path.join(dir, 'secret');
  fs.writeFileSync(secret, '{"network":{"mode":"one"}}');
  fs.symlinkSync(secret, path.join(dir, 'apply.json'));
  assert.throws(() => readRequest(path.join(dir, 'apply.json')), /ELOOP|symbolic|too many/i);
  fs.writeFileSync(path.join(dir, 'real.json'), '{"id":"x"}');
  assert.deepEqual(readRequest(path.join(dir, 'real.json')), { id: 'x' });
});
