'use strict';

// First-run setup: the one-time setup code, validation of the wizard's
// choices, and the request handed to the root-only apply helper.
//
// Everything here is plain functions so it can be tested without a server.
// The root helper (apply.js) re-validates every request with the same
// functions: the web service is never trusted with root-level changes.

const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { checkStrength } = require('./passwords');
const { checkWifi } = require('./wifi');

// No 0/O, 1/I/L: easy to read aloud and to type.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function newSetupCode() {
  const bytes = crypto.randomBytes(10);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}
const normCode = (c) => String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const hashCode = (c) => crypto.createHash('sha256').update(`benchwise-setup:${normCode(c)}`).digest('hex');

const TIME_ZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles',
  'America/Anchorage', 'Pacific/Honolulu', 'America/Puerto_Rico', 'UTC',
];

/** This machine's IPv4 addresses, by network card (what the wizard offers). */
function localInterfaces(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces || {})) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' || a.family === 4) {
        if (!a.internal) out.push({ name, address: a.address, cidr: a.cidr || null });
      }
    }
  }
  return out;
}

const isIPv4 = (s) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(String(s || ''));

/** Network choice -> errors. Two networks need two different addresses of THIS machine. */
function checkNetwork(net, interfaces) {
  const errors = [];
  if (!net || !['one', 'two'].includes(net.mode)) return ['Choose one network or two.'];
  if (net.mode === 'two') {
    const mine = new Set(interfaces.map((i) => i.address));
    for (const [label, ip] of [['company', net.companyIp], ['floor', net.floorIp]]) {
      if (!isIPv4(ip)) errors.push(`Choose the ${label} network card.`);
      else if (!mine.has(ip)) errors.push(`${ip} is not an address of this server.`);
    }
    if (net.companyIp && net.companyIp === net.floorIp) errors.push('The company and floor sides must be different network cards.');
  }
  return errors;
}

/** Certificate choice -> errors (and the certificate's fingerprint when uploaded). */
function checkCertificate(cert, { now = new Date() } = {}) {
  if (!cert || cert.mode === 'generated') return { errors: [] };
  if (cert.mode !== 'upload') return { errors: ['Choose a certificate option.'] };
  const errors = [];
  const pem = (v) => typeof v === 'string' && v.length < 64 * 1024 && v.includes('-----BEGIN');
  if (!pem(cert.certPem)) errors.push('Paste the certificate (PEM, starting with -----BEGIN CERTIFICATE-----).');
  if (!pem(cert.keyPem)) errors.push('Paste the private key (PEM, starting with -----BEGIN ... PRIVATE KEY-----).');
  if (errors.length) return { errors };
  let x509;
  let key;
  try {
    x509 = new crypto.X509Certificate(cert.certPem);
  } catch {
    return { errors: ["The certificate couldn't be read. Paste it in PEM format."] };
  }
  try {
    key = crypto.createPrivateKey(cert.keyPem);
  } catch {
    return { errors: ["The private key couldn't be read (an encrypted key needs its password removed first)."] };
  }
  const der = (k) => k.export({ type: 'spki', format: 'der' });
  if (!der(x509.publicKey).equals(der(crypto.createPublicKey(key)))) errors.push("The private key doesn't belong to this certificate.");
  if (new Date(x509.validTo) < now) errors.push(`The certificate expired on ${x509.validTo}.`);
  if (new Date(x509.validFrom) > now) errors.push(`The certificate isn't valid until ${x509.validFrom}.`);
  return { errors, fingerprint: x509.fingerprint256 };
}

/** Validates the whole wizard submission. Returns { errors: [...] } or { plan }. */
function checkSetup(body, { interfaces }) {
  const errors = [];
  const b = body || {};
  const site = b.site || {};
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,15}$/.test(site.code || '')) errors.push('Facility code: 2-16 letters, digits or dashes (e.g. DAL).');
  if (!site.name || String(site.name).trim().length > 120) errors.push('Facility name is required.');
  if (!TIME_ZONES.includes(site.timeZone)) errors.push('Choose a time zone.');
  errors.push(...checkNetwork(b.network, interfaces));
  const cert = checkCertificate(b.certificate);
  errors.push(...cert.errors);
  // Floor Wi-Fi for sticks: optional here (wired floors), editable later.
  let wifi = null;
  if (b.wifi && b.wifi.ssid) {
    const w = checkWifi(b.wifi);
    if (w.errors) errors.push(...w.errors);
    else wifi = w.wifi;
  }
  const admin = b.admin || {};
  if (!/^[a-z0-9._-]{3,40}$/.test(admin.username || '')) errors.push('Admin username: 3-40 lowercase letters, digits, dot, dash or underscore.');
  const weak = checkStrength(admin.password);
  if (weak) errors.push(`Admin password: ${weak}`);
  if (admin.password !== admin.confirm) errors.push("The admin passwords don't match.");
  if (errors.length) return { errors };
  return {
    plan: {
      site: { code: site.code.toUpperCase(), name: String(site.name).trim(), timeZone: site.timeZone },
      network: b.network.mode === 'two' ? { mode: 'two', companyIp: b.network.companyIp, floorIp: b.network.floorIp } : { mode: 'one' },
      certificate: b.certificate?.mode === 'upload' ? { mode: 'upload', certPem: b.certificate.certPem, keyPem: b.certificate.keyPem } : { mode: 'generated' },
      wifi,
      admin: { username: admin.username, password: admin.password },
    },
  };
}

// ---------------------------------------------------------------- settings table

async function getSetting(db, key) {
  const r = await db.query('SELECT value FROM server_settings WHERE key = $1', [key]);
  return r.rows[0]?.value ?? null;
}
async function setSetting(db, key, value) {
  await db.query(
    `INSERT INTO server_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

// ---------------------------------------------------------------- the root helper's inbox

/** Hands the network/certificate part to the root helper (atomic write, owner-only). */
function writeApplyRequest(dir, request) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'apply.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(request), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

module.exports = {
  newSetupCode,
  hashCode,
  normCode,
  localInterfaces,
  checkNetwork,
  checkCertificate,
  checkSetup,
  getSetting,
  setSetting,
  writeApplyRequest,
  TIME_ZONES,
  isIPv4,
};
