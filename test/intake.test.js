'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRegQuery, readKey } = require('../src/main/intake/registry');
const { detectEnvironment, classifyWindows, classifyLinux } = require('../src/main/intake/environment');
const { runMdmCheck, classifyTenant, parseKnownTenants, loadKnownTenants, mdmVerdict, REGISTRY_PATHS } = require('../src/main/intake/mdm');

const DIAG = REGISTRY_PATHS[0];
const ENROLL = REGISTRY_PATHS[1];
const GUID = '{1b2c3d4e-0000-4000-8000-123456789abc}';
const GUID_CLEAN = '1b2c3d4e-0000-4000-8000-123456789abc';

// ---------------------------------------------------------------- registry

const REG_OUTPUT = [
  '',
  'HKEY_LOCAL_MACHINE\\SYSTEM\\Setup',
  '    (Default)    REG_SZ    ',
  '    CmdLine    REG_SZ    oobe\\windeploy.exe',
  '    OOBEInProgress    REG_DWORD    0x1',
  '    SystemSetupInProgress    REG_DWORD    0x1',
  '    Setup Phase Name    REG_SZ    some value with spaces',
  '    Big    REG_QWORD    0x10',
  '',
  'HKEY_LOCAL_MACHINE\\SYSTEM\\Setup\\Status',
  '',
].join('\r\n');

test('reg query output: DWORDs as numbers, names with spaces, empty default', () => {
  assert.deepEqual(parseRegQuery(REG_OUTPUT), {
    '': '',
    CmdLine: 'oobe\\windeploy.exe',
    OOBEInProgress: 1,
    SystemSetupInProgress: 1,
    'Setup Phase Name': 'some value with spaces',
    Big: 16,
  });
});

test('readKey: a missing key is null, never an exception', async () => {
  const missing = await readKey('HKLM\\Nope', { exec: (_c, _a, _o, cb) => cb(Object.assign(new Error('exit 1'), { code: 1 }), '') });
  assert.equal(missing, null);
  const found = await readKey('HKLM\\SYSTEM\\Setup', { exec: (_c, args, _o, cb) => cb(null, args[1] === 'HKLM\\SYSTEM\\Setup' ? REG_OUTPUT : '') });
  assert.equal(found.OOBEInProgress, 1);
});

// ---------------------------------------------------------------- environment

test('Windows environment: OOBE, audit mode, WinPE and finished setup', () => {
  assert.equal(classifyWindows({ setup: { OOBEInProgress: 1, SystemSetupInProgress: 1 }, status: {} }), 'oobe');
  assert.equal(classifyWindows({ setup: { OOBEInProgress: 0, SystemSetupInProgress: 1 }, status: {} }), 'oobe');
  assert.equal(classifyWindows({ setup: { SystemSetupInProgress: 1 }, status: { AuditBoot: 1 } }), 'audit', 'audit mode wins over setup-in-progress');
  assert.equal(classifyWindows({ setup: { OOBEInProgress: 0, SystemSetupInProgress: 0 }, status: {} }), 'windows');
  assert.equal(classifyWindows({ setup: null, status: null, miniNt: {} }), 'winpe');
  assert.equal(classifyWindows({ setup: null, status: null }), 'windows');
});

test('Linux environment: live USB vs installed', () => {
  assert.equal(classifyLinux('BOOT_IMAGE=/casper/vmlinuz boot=casper quiet splash'), 'live');
  assert.equal(classifyLinux('initrd=/live/initrd.img boot=live components'), 'live');
  assert.equal(classifyLinux('BOOT_IMAGE=/boot/vmlinuz root=UUID=abc ro quiet'), 'linux');
});

test('detectEnvironment keeps the raw evidence for checking against real units', async () => {
  const keys = { 'HKLM\\SYSTEM\\Setup': { OOBEInProgress: 1, SystemSetupInProgress: 1, SetupType: 0, Unrelated: 'x' }, 'HKLM\\SYSTEM\\Setup\\Status': {} };
  const env = await detectEnvironment({ platform: 'win32', read: async (k) => keys[k] || null, user: () => 'defaultuser0' });
  assert.equal(env.mode, 'oobe');
  assert.deepEqual(env.evidence, { setup: { OOBEInProgress: 1, SystemSetupInProgress: 1, SetupType: 0 }, status: {}, miniNt: false, username: 'defaultuser0' });
  assert.equal((await detectEnvironment({ platform: 'darwin', user: () => 'x' })).mode, 'macos');
});

// ---------------------------------------------------------------- MDM: pure logic

test('known tenants file: v1 format, case-insensitive ids, junk lines ignored', () => {
  const map = parseKnownTenants(`${GUID_CLEAN.toUpperCase()}=Contoso Ltd\r\n\r\nno equals sign\r\n=missing id\r\nabc = Fabrikam \n`);
  assert.deepEqual([...map], [[GUID_CLEAN, 'Contoso Ltd'], ['abc', 'Fabrikam']]);
});

test("tenant classification follows v1 exactly", () => {
  const known = parseKnownTenants(`${GUID_CLEAN}=Contoso Ltd`);
  assert.deepEqual(classifyTenant(null, known), { status: 'clean', vendor: null });
  assert.deepEqual(classifyTenant('   ', known), { status: 'clean', vendor: null });
  assert.deepEqual(classifyTenant(GUID, known), { status: 'locked', vendor: 'Contoso Ltd', reason: 'known-tenant' }, 'braces stripped before lookup');
  assert.deepEqual(classifyTenant('contoso.onmicrosoft.com'), { status: 'locked', vendor: null, reason: 'domain' });
  assert.deepEqual(classifyTenant(GUID), { status: 'ghost', vendor: null }, 'unknown GUID = ghost');
});

test('verdicts: clean passes, locked fails (site setting), ghost and unverified need a person', () => {
  assert.equal(mdmVerdict({ status: 'clean' }).status, 'pass');
  const locked = mdmVerdict({ status: 'locked', vendor: 'Contoso Ltd', tenant: GUID_CLEAN });
  assert.equal(locked.status, 'fail');
  assert.equal(locked.summary, 'Locked to Contoso Ltd: send to salvage.');
  assert.equal(mdmVerdict({ status: 'locked', tenant: 'x.onmicrosoft.com' }, { lockedFails: false }).status, null, 'site records locks without failing');
  assert.match(mdmVerdict({ status: 'locked', tenant: 'x.onmicrosoft.com' }).summary, /Locked to x\.onmicrosoft\.com/);
  assert.equal(mdmVerdict({ status: 'ghost', tenant: GUID_CLEAN }).status, null);
  assert.match(mdmVerdict({ status: 'ghost', tenant: GUID_CLEAN }).summary, /check by hand/i);
  assert.equal(mdmVerdict({ status: 'unverified' }).status, null);
});

// ---------------------------------------------------------------- MDM: the run

function fakeIo({ reachable = () => true, pingOk = () => true, registry = () => ({}) } = {}) {
  const log = { sleeps: [], pings: 0, heads: 0, reads: 0, progress: [] };
  return {
    log,
    deps: {
      pingHost: async () => (log.pings++, pingOk(log.pings)),
      reach: async (url) => (log.heads++, reachable(url, log.heads)),
      read: async (key) => (log.reads++, registry(key, log.reads)),
      sleep: async (ms) => log.sleeps.push(ms),
      onProgress: (p) => log.progress.push(p),
      now: () => 0,
    },
  };
}

test('clean unit: network OK, ~30 s of polling (10 rounds), no tenant', async () => {
  const { log, deps } = fakeIo();
  const r = await runMdmCheck(deps);
  assert.equal(r.status, 'clean');
  assert.equal(r.network.ok, true);
  assert.equal(r.network.checks.length, 4, 'ping + three Microsoft services');
  assert.equal(log.progress.filter((p) => p.step === 'poll').length, 10);
  assert.deepEqual(log.sleeps, Array(9).fill(3000), 'v1 polls 10 x 3 s');
});

test('locked unit: tenant appears on the third round under the Enrollment key', async () => {
  const known = parseKnownTenants(`${GUID_CLEAN}=Contoso Ltd`);
  const { deps } = fakeIo({ registry: (key, n) => (key === ENROLL && n >= 6 ? { TenantId: GUID } : {}) });
  const r = await runMdmCheck({ ...deps, known });
  assert.equal(r.status, 'locked');
  assert.equal(r.vendor, 'Contoso Ltd');
  assert.equal(r.tenant, GUID_CLEAN);
  assert.equal(r.registryPath, ENROLL);
});

test('ghost: unknown tenant GUID; CloudAssigned values recorded but never decide', async () => {
  const { deps } = fakeIo({
    registry: (key) => (key === DIAG ? { TenantId: GUID, CloudAssignedTenantDomain: 'contoso.onmicrosoft.com' } : {}),
  });
  const r = await runMdmCheck(deps);
  assert.equal(r.status, 'ghost', 'v1 reads TenantId only, so the domain does not make it Locked');
  assert.deepEqual(r.cloudAssigned, { tenantId: null, tenantDomain: 'contoso.onmicrosoft.com' });
});

test('CloudAssignedTenantId alone (no TenantId) stays clean, as in v1', async () => {
  const { deps } = fakeIo({ registry: (key) => (key === DIAG ? { CloudAssignedTenantId: GUID_CLEAN } : {}) });
  const r = await runMdmCheck(deps);
  assert.equal(r.status, 'clean');
  assert.equal(r.cloudAssigned.tenantId, GUID_CLEAN);
});

test("network gate: retries 4 times, then stops with no result (never 'clean')", async () => {
  const { log, deps } = fakeIo({ reachable: (url) => !url.includes('ztd.dds') });
  const r = await runMdmCheck({ ...deps, read: async () => ({ TenantId: GUID }) });
  assert.equal(r.status, 'unverified');
  assert.equal(r.network.attempts, 4);
  assert.deepEqual(log.sleeps, [3000, 3000, 3000]);
  assert.equal(log.progress.some((p) => p.step === 'poll'), false, 'the registry is never read without Microsoft');
  assert.deepEqual(r.network.checks.filter((c) => !c.ok).map((c) => c.target), ['https://ztd.dds.microsoft.com']);
});

test('network gate: a failed ping alone also blocks; a recovery on attempt 2 continues', async () => {
  const blocked = fakeIo({ pingOk: () => false });
  assert.equal((await runMdmCheck(blocked.deps)).status, 'unverified');
  const recovers = fakeIo({ pingOk: (n) => n >= 2 });
  const r = await runMdmCheck(recovers.deps);
  assert.equal(r.status, 'clean');
  assert.equal(r.network.attempts, 2);
});

test('known tenants: first readable file wins; none found is an empty list, not an error', async () => {
  const files = { '/share/KnownTenants.txt': `${GUID_CLEAN}=Contoso Ltd` };
  const readFile = async (f) => {
    if (!(f in files)) throw new Error('ENOENT');
    return files[f];
  };
  const hit = await loadKnownTenants(['', '/missing.txt', '/share/KnownTenants.txt'], { readFile });
  assert.equal(hit.source, '/share/KnownTenants.txt');
  assert.equal(hit.count, 1);
  const none = await loadKnownTenants(['/missing.txt'], { readFile });
  assert.deepEqual([none.source, none.count], [null, 0]);
});

test('BENCHWISE_ENV_MODE overrides the detected mode and says so', async () => {
  const env = await detectEnvironment({ platform: 'darwin', user: () => 'x', envVars: { BENCHWISE_ENV_MODE: 'oobe' } });
  assert.deepEqual([env.mode, env.detectedMode, env.source], ['oobe', 'macos', 'override']);
  const ignored = await detectEnvironment({ platform: 'darwin', user: () => 'x', envVars: { BENCHWISE_ENV_MODE: 'bogus' } });
  assert.equal(ignored.mode, 'macos');
});
