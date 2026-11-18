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
// Safety nets on top of v1 (agreed 2026-11-18). They can only make a result
// MORE cautious, never turn Locked/Ghost into Clean:
//
//  - The registry must be readable at all, otherwise "can't verify".
//  - v1 found no TenantId, but other Windows records show a tenant
//    (CloudAssignedTenantId/-Domain/-Upn, forced enrollment, ProfileAvailable,
//    or the cached Autopilot profile) -> ghost: check by hand.
//  - Microsoft answered "registered, but no profile assigned" -> ghost.
//  - Clean is CONFIRMED only when Windows' Autopilot policy cache holds
//    Microsoft's own answer 807 "ZtdDeviceIsNotRegistered", fetched since this
//    boot. With no answer, or only an older one (the unit may have been
//    registered since), the result is "clean, unconfirmed": no automatic
//    verdict.

const fs = require('node:fs/promises');
const https = require('node:https');
const { execFile } = require('node:child_process');
const { readKey } = require('./registry');

const PING_HOST = '8.8.8.8';
const ENDPOINTS = ['https://ztd.dds.microsoft.com', 'https://login.microsoftonline.com', 'https://enterpriseregistration.windows.net'];
const REGISTRY_PATHS = ['HKLM\\SOFTWARE\\Microsoft\\Provisioning\\Diagnostics\\Autopilot', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\Autopilot\\Enrollment'];
const POLICY_CACHE = 'HKLM\\SOFTWARE\\Microsoft\\Provisioning\\AutopilotPolicyCache';
// Any key that always exists: proves reg.exe works and we can read HKLM.
const REGISTRY_CANARY = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';
// After v1's 30 s, wait up to this long more for Microsoft's answer to land.
const CONFIRM_ROUNDS = 10;
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

const nonEmpty = (v) => (typeof v === 'string' ? v.trim() !== '' : false);

/**
 * Pure: the AutopilotPolicyCache key -> Microsoft's last answer. The cached
 * JSON holds the download date, an error code (807 = not registered) and,
 * for a registered unit, the tenant.
 */
function parsePolicyCache(values) {
  if (!values) return null;
  let json = null;
  try {
    json = values.PolicyJsonCache ? JSON.parse(values.PolicyJsonCache) : null;
  } catch {
    json = null;
  }
  let zero = null;
  try {
    const aad = typeof json?.CloudAssignedAadServerData === 'string' ? JSON.parse(json.CloudAssignedAadServerData) : json?.CloudAssignedAadServerData;
    zero = aad?.ZeroTouchConfig || null;
  } catch {
    zero = null;
  }
  return {
    profileAvailable: typeof values.ProfileAvailable === 'number' ? values.ProfileAvailable === 1 : null,
    errorCode: json?.ErrorCode ?? null,
    errorReason: json?.ErrorReason || null,
    downloadedAt: json?.PolicyDownloadDate || null,
    tenantId: json?.CloudAssignedTenantId || null,
    tenantDomain: json?.CloudAssignedTenantDomain || zero?.CloudAssignedTenantDomain || null,
    tenantUpn: zero?.CloudAssignedTenantUpn || null,
    forcedEnrollment: Number(json?.CloudAssignedForcedEnrollment ?? zero?.ForcedEnrollment ?? 0) === 1,
  };
}

/**
 * Pure: everything Windows records besides v1's TenantId -> evidence of a
 * tenant (strings describing what was found), plus Microsoft's answer.
 */
function tenantEvidence(diag, cache) {
  const found = [];
  if (diag) {
    if (nonEmpty(diag.CloudAssignedTenantId)) found.push(`CloudAssignedTenantId ${diag.CloudAssignedTenantId}`);
    if (nonEmpty(diag.CloudAssignedTenantDomain)) found.push(`CloudAssignedTenantDomain ${diag.CloudAssignedTenantDomain}`);
    if (nonEmpty(diag.CloudAssignedTenantUpn)) found.push(`CloudAssignedTenantUpn ${diag.CloudAssignedTenantUpn}`);
    if (diag.CloudAssignedForcedEnrollment === 1) found.push('CloudAssignedForcedEnrollment = 1');
  }
  if (cache) {
    if (cache.profileAvailable) found.push('ProfileAvailable = 1 (an Autopilot profile was downloaded)');
    if (cache.tenantId) found.push(`cached profile tenant ${cache.tenantId}`);
    if (cache.tenantDomain) found.push(`cached profile domain ${cache.tenantDomain}`);
    if (cache.tenantUpn) found.push(`cached profile UPN ${cache.tenantUpn}`);
    if (cache.forcedEnrollment) found.push('cached profile forces enrollment');
    if (cache.errorCode === 815 || /HasNoAssignedProfile/i.test(cache.errorReason || '')) {
      found.push('Microsoft: registered to an organisation, no profile assigned yet');
    }
  }
  return found;
}

/**
 * Pure: when v1 says clean, is that confirmed by Microsoft's answer from
 * this boot? Returns { confirmed, why }.
 */
function confirmClean(cache, bootTime) {
  if (!cache || (cache.errorCode == null && !cache.errorReason)) return { confirmed: false, why: 'Windows has no record of asking Microsoft for an Autopilot profile.' };
  const notRegistered = cache.errorCode === 807 || /ZtdDeviceIsNotRegistered/i.test(cache.errorReason || '');
  if (!notRegistered) return { confirmed: false, why: `Microsoft's last answer was not "not registered" (${cache.errorCode ?? '?'} ${cache.errorReason || ''}).`.replace(' )', ')') };
  const at = Date.parse(cache.downloadedAt || '');
  if (!Number.isFinite(at)) return { confirmed: false, why: 'Microsoft answered "not registered", but the answer has no date.' };
  if (bootTime != null && at < bootTime) {
    return { confirmed: false, why: `Microsoft's "not registered" answer is from before this boot (${cache.downloadedAt}); the unit could have been registered since.` };
  }
  return { confirmed: true, why: `Microsoft answered "not registered" at ${cache.downloadedAt}.` };
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
      return { status: 'pass', summary: `Clean: no Autopilot profile, and Microsoft confirms the unit is not registered.` };
    case 'unconfirmed':
      return {
        status: null,
        summary: `No Autopilot profile found, but Microsoft's answer couldn't be confirmed: ${result.confirmation || ''} Reconnect the network and run the check again, or check by hand.`.replace('  ', ' '),
      };
    case 'locked':
      return {
        status: lockedFails ? 'fail' : null,
        summary: `Locked to ${who}: send to salvage.`,
      };
    case 'ghost':
      return {
        status: null,
        summary: result.safetyNet
          ? `Possible lock: v1's check found no tenant, but Windows records show one (${(result.evidence || []).join('; ')}). Check by hand: go through setup with Wi-Fi connected and see whether it forces a corporate sign-in.`
          : 'Ghost profile: an unknown tenant ID, which is not always a lock. Check by hand: go through setup with Wi-Fi connected and see whether it forces a corporate sign-in.',
      };
    case 'unverified':
      return {
        status: null,
        summary: result.registryReadable === false
          ? "Can't verify: the Windows registry couldn't be read, so a locked unit could look clean. Run Benchwise as administrator and try again."
          : "Can't verify: Microsoft's services aren't reachable, so a locked unit could look clean. Fix the network and run the check again.",
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
  // When this boot started: an older answer from Microsoft doesn't count.
  bootTime = Date.now() - require('node:os').uptime() * 1000,
} = {}) {
  const started = now();
  const result = {
    status: null,
    tenant: null,
    vendor: null,
    lockReason: null,
    registryPath: null,
    registryReadable: null,
    cloudAssigned: null,
    policyCache: null,
    evidence: [],
    safetyNet: null,
    confirmation: null,
    network: { ok: false, attempts: 0, checks: [] },
    knownTenants: known.size,
    checkedAt: null,
    durationMs: 0,
  };
  const finish = (status) => {
    result.status = status;
    result.checkedAt = new Date().toISOString();
    result.durationMs = now() - started;
    return result;
  };

  // 0. Safety net: the registry must be readable, or "nothing found" means nothing.
  result.registryReadable = (await read(REGISTRY_CANARY)) != null;
  if (!result.registryReadable) return finish('unverified');

  // 1. Network gate (v1)
  for (let attempt = 1; attempt <= GATE_ATTEMPTS && !result.network.ok; attempt++) {
    onProgress({ step: 'network', attempt, of: GATE_ATTEMPTS });
    const checks = [{ target: PING_HOST, ok: await pingHost(PING_HOST) }];
    for (const url of ENDPOINTS) checks.push({ target: url, ok: await reach(url) });
    result.network = { ok: checks.every((c) => c.ok), attempts: attempt, checks };
    if (!result.network.ok && attempt < GATE_ATTEMPTS) await sleep(GATE_RETRY_MS);
  }
  if (!result.network.ok) return finish('unverified');

  // 2. Poll the registry for v1's TenantId (v1: 10 x 3 s)
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

  // 3. v1's classification. Locked and ghost stand exactly as v1 decides.
  const c = classifyTenant(tenant, known);
  result.tenant = tenant ? cleanTenant(tenant) : null;
  result.vendor = c.vendor;
  result.lockReason = c.reason || null;

  // Everything else Windows records about Autopilot (kept in every report).
  const readEvidence = async () => {
    const diag = await read(REGISTRY_PATHS[0]);
    const cache = parsePolicyCache(await read(POLICY_CACHE));
    result.cloudAssigned = diag
      ? {
          tenantId: diag.CloudAssignedTenantId || null,
          tenantDomain: diag.CloudAssignedTenantDomain || null,
          tenantUpn: diag.CloudAssignedTenantUpn || null,
          forcedEnrollment: diag.CloudAssignedForcedEnrollment ?? null,
          autopilotDisabled: diag.IsAutoPilotDisabled ?? null,
        }
      : null;
    result.policyCache = cache;
    result.evidence = tenantEvidence(diag, cache);
    return cache;
  };
  let cache = await readEvidence();
  if (c.status !== 'clean') return finish(c.status);

  // 4. Safety nets: v1 says clean. Any other sign of a tenant -> check by hand.
  if (result.evidence.length) {
    result.safetyNet = 'tenant-evidence';
    return finish('ghost');
  }
  // Clean only with Microsoft's own fresh "not registered". It may land a
  // little after v1's 30 s, so wait for it a while longer.
  let conf = confirmClean(cache, bootTime);
  for (let round = 1; round <= CONFIRM_ROUNDS && !conf.confirmed; round++) {
    onProgress({ step: 'confirm', round, of: CONFIRM_ROUNDS });
    await sleep(POLL_INTERVAL_MS);
    cache = await readEvidence();
    if (result.evidence.length) {
      result.safetyNet = 'tenant-evidence';
      return finish('ghost');
    }
    conf = confirmClean(cache, bootTime);
  }
  result.confirmation = conf.why;
  if (!conf.confirmed) {
    result.safetyNet = 'not-confirmed';
    return finish('unconfirmed');
  }
  return finish('clean');
}

module.exports = {
  runMdmCheck,
  classifyTenant,
  parsePolicyCache,
  tenantEvidence,
  confirmClean,
  parseKnownTenants,
  loadKnownTenants,
  mdmVerdict,
  ENDPOINTS,
  REGISTRY_PATHS,
};
