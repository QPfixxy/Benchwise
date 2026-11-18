'use strict';

// MDM / Autopilot lock check, ported from the intake toolkit's v1
// MDM_Check.ps1, which is proven in production during Windows setup (OOBE).
// The detection logic is deliberately unchanged:
//
//  1. Network gate. 8.8.8.8 must answer a ping and three Microsoft services
//     must answer HTTP, up to 4 attempts 3 s apart. If not, STOP with no
//     result: without Microsoft, a locked unit would look clean.
//  2. Poll the Autopilot registry for ~30 s (10 x 3 s) for a TenantId value,
//     first under Provisioning\Diagnostics\Autopilot, then
//     Windows\Autopilot\Enrollment.
//  3. Classify the TenantId (braces and spaces removed):
//       none                          -> clean
//       in the known-tenants list     -> locked (with the client's name)
//       contains a dot (a domain)     -> locked
//       anything else (unknown GUID)  -> ghost: check by hand, a ghost
//                                        profile isn't always a lock
//
// The CloudAssignedTenantId/-Domain values are recorded as extra evidence
// only; they never change the result.

const fs = require('node:fs/promises');
const https = require('node:https');
const { execFile } = require('node:child_process');
const { readKey } = require('./registry');

const PING_HOST = '8.8.8.8';
const ENDPOINTS = ['https://ztd.dds.microsoft.com', 'https://login.microsoftonline.com', 'https://enterpriseregistration.windows.net'];
const REGISTRY_PATHS = ['HKLM\\SOFTWARE\\Microsoft\\Provisioning\\Diagnostics\\Autopilot', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\Autopilot\\Enrollment'];
const GATE_ATTEMPTS = 4;
const GATE_RETRY_MS = 3000;
const POLL_ROUNDS = 10;
const POLL_INTERVAL_MS = 3000;

// ---------------------------------------------------------------- pure logic

/** Parses KnownTenants.txt: one "TenantId=Client name" per line (v1 format). */
function parseKnownTenants(text = '') {
  const map = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const parts = line.split('=');
    // v1 compares with PowerShell -eq, which ignores case.
    if (parts.length >= 2 && parts[0].trim()) map.set(parts[0].trim().toLowerCase(), parts[1].trim());
  }
  return map;
}

const cleanTenant = (t) => String(t || '').replace(/[{}\s]/g, '');

/** Pure: v1's classification of the TenantId found in the registry. */
function classifyTenant(tenant, known = new Map()) {
  if (!tenant || !String(tenant).trim()) return { status: 'clean', vendor: null };
  const id = cleanTenant(tenant);
  const vendor = known.get(id.toLowerCase()) || null;
  if (vendor) return { status: 'locked', vendor, reason: 'known-tenant' };
  if (id.includes('.')) return { status: 'locked', vendor: null, reason: 'domain' };
  return { status: 'ghost', vendor: null };
}

/**
 * Pure: result -> test verdict. Ghost and "can't verify" get no automatic
 * verdict; the technician decides.
 * @param {{lockedFails?: boolean}} policy  site setting (default: locked fails)
 */
function mdmVerdict(result, { lockedFails = true } = {}) {
  const who = result.vendor || result.tenant;
  switch (result.status) {
    case 'clean':
      return { status: 'pass', summary: 'Clean: no Autopilot profile found.' };
    case 'locked':
      return {
        status: lockedFails ? 'fail' : null,
        summary: `Locked to ${who}: send to salvage.`,
      };
    case 'ghost':
      return {
        status: null,
        summary: 'Ghost profile: an unknown tenant ID, which is not always a lock. Check by hand: go through setup with Wi-Fi connected and see whether it forces a corporate sign-in.',
      };
    case 'unverified':
      return {
        status: null,
        summary: "Can't verify: Microsoft's services aren't reachable, so a locked unit could look clean. Fix the network and run the check again.",
      };
    default:
      return { status: null, summary: result.message || 'The check did not finish.' };
  }
}

// ---------------------------------------------------------------- I/O

function ping(host, { exec = execFile } = {}) {
  const args = process.platform === 'win32' ? ['-n', '1', '-w', '3000', host] : ['-c', '1', '-W', '3', host];
  return new Promise((resolve) => exec('ping', args, { timeout: 8000, windowsHide: true }, (err) => resolve(!err)));
}

/** True if the URL answers with any HTTP response (even 4xx), like v1's `curl -I`. */
function httpReachable(url, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * Finds KnownTenants.txt. Never part of the app: it's client data. Looks at
 * the configured path (e.g. the intake share), then the data folder (the USB
 * stick in portable mode).
 */
async function loadKnownTenants(candidates = [], { readFile = fs.readFile } = {}) {
  for (const file of candidates.filter(Boolean)) {
    try {
      const map = parseKnownTenants(await readFile(file, 'utf8'));
      return { map, source: file, count: map.size };
    } catch {
      /* try the next one */
    }
  }
  return { map: new Map(), source: null, count: 0 };
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs the check. Every dependency is injectable for tests.
 * @param {object} o
 * @param {Map}    o.known       known tenants (lowercase id -> name)
 * @param {(e: object) => void} [o.onProgress]
 */
async function runMdmCheck({
  known = new Map(),
  onProgress = () => {},
  pingHost = ping,
  reach = httpReachable,
  read = readKey,
  sleep = sleepMs,
  now = Date.now,
} = {}) {
  const started = now();
  const result = {
    status: null,
    tenant: null,
    vendor: null,
    lockReason: null,
    registryPath: null,
    cloudAssigned: null,
    network: { ok: false, attempts: 0, checks: [] },
    knownTenants: known.size,
    checkedAt: null,
    durationMs: 0,
  };

  // 1. Network gate
  for (let attempt = 1; attempt <= GATE_ATTEMPTS && !result.network.ok; attempt++) {
    onProgress({ step: 'network', attempt, of: GATE_ATTEMPTS });
    const checks = [{ target: PING_HOST, ok: await pingHost(PING_HOST) }];
    for (const url of ENDPOINTS) checks.push({ target: url, ok: await reach(url) });
    result.network = { ok: checks.every((c) => c.ok), attempts: attempt, checks };
    if (!result.network.ok && attempt < GATE_ATTEMPTS) await sleep(GATE_RETRY_MS);
  }
  if (!result.network.ok) {
    result.status = 'unverified';
    result.checkedAt = new Date().toISOString();
    result.durationMs = now() - started;
    return result;
  }

  // 2. Poll the registry
  let tenant = null;
  for (let round = 1; round <= POLL_ROUNDS && !tenant; round++) {
    onProgress({ step: 'poll', round, of: POLL_ROUNDS });
    for (const key of REGISTRY_PATHS) {
      const value = (await read(key))?.TenantId;
      if (value && String(value).trim()) {
        tenant = String(value);
        result.registryPath = key;
        break;
      }
    }
    if (!tenant && round < POLL_ROUNDS) await sleep(POLL_INTERVAL_MS);
  }

  // Extra evidence only (v2's wider read); never changes the result.
  const diag = await read(REGISTRY_PATHS[0]);
  if (diag && (diag.CloudAssignedTenantId || diag.CloudAssignedTenantDomain)) {
    result.cloudAssigned = { tenantId: diag.CloudAssignedTenantId || null, tenantDomain: diag.CloudAssignedTenantDomain || null };
  }

  // 3. Classify
  const c = classifyTenant(tenant, known);
  result.status = c.status;
  result.tenant = tenant ? cleanTenant(tenant) : null;
  result.vendor = c.vendor;
  result.lockReason = c.reason || null;
  result.checkedAt = new Date().toISOString();
  result.durationMs = now() - started;
  return result;
}

module.exports = {
  runMdmCheck,
  classifyTenant,
  parseKnownTenants,
  loadKnownTenants,
  mdmVerdict,
  ENDPOINTS,
  REGISTRY_PATHS,
};
