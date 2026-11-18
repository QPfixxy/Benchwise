'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRegQuery, readKey } = require('../src/main/intake/registry');
const { detectEnvironment, classifyWindows, classifyLinux } = require('../src/main/intake/environment');
const { runMdmCheck, classifyTenant, parseKnownTenants, loadKnownTenants, mdmVerdict, parsePolicyCache, tenantEvidence, confirmClean, REGISTRY_PATHS } = require('../src/main/intake/mdm');

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
  assert.equal(mdmVerdict({ status: 'unconfirmed', confirmation: 'x.' }).status, null);
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

// Real AutopilotPolicyCache from a test VM (Windows 11 26100, not registered).
const REAL_POLICY_JSON =
  '{"ErrorCode":807,"ErrorReason":"ZtdDeviceIsNotRegistered","PolicyDownloadCorrelationVector":"d82dbca1-7196-4359-8bb3-e8488aa5c503","PolicyDownloadDate":"2026-11-17T23:34:49Z","AutopilotCreationDate":"2026-11-18T02:37:21Z","AutopilotUpdateTimeout":1800000,"AutopilotCorrelationVector":"EHvvC/gtE0W0FWI1.0","CloudAssignedAadServerData":"{\\"ZeroTouchConfig\\":{\\"CloudAssignedTenantDomain\\":\\"\\",\\"CloudAssignedTenantUpn\\":\\"\\",\\"ForcedEnrollment\\":0}}"}';
const BOOT = Date.parse('2026-11-17T20:00:00Z'); // the answer above came after this boot
const POLICY = (json = REAL_POLICY_JSON, profileAvailable = 0) => ({ PolicyJsonCache: json, ProfileAvailable: profileAvailable });
const POLICY_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Provisioning\\AutopilotPolicyCache';

function fakeIo({ reachable = () => true, pingOk = () => true, registry = (key) => (key === POLICY_KEY ? POLICY() : {}) } = {}) {
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
      bootTime: BOOT,
    },
  };
}

test('clean unit: network OK, ~30 s of polling (10 rounds), confirmed by Microsoft (807, this boot)', async () => {
  const { log, deps } = fakeIo();
  const r = await runMdmCheck(deps);
  assert.equal(r.status, 'clean');
  assert.match(r.confirmation, /not registered/);
  assert.equal(r.policyCache.errorCode, 807);
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
  assert.equal(r.safetyNet, null, "v1's own ghost, not the safety net");
  assert.equal(r.cloudAssigned.tenantDomain, 'contoso.onmicrosoft.com');
});

test('safety net: CloudAssignedTenantId without TenantId is never clean (v1 would say clean)', async () => {
  const { deps } = fakeIo({ registry: (key) => (key === DIAG ? { CloudAssignedTenantId: GUID_CLEAN } : key === POLICY_KEY ? POLICY() : {}) });
  const r = await runMdmCheck(deps);
  assert.equal(r.status, 'ghost');
  assert.equal(r.safetyNet, 'tenant-evidence');
  assert.match(mdmVerdict(r).summary, /Possible lock: .*CloudAssignedTenantId/);
  assert.equal(mdmVerdict(r).status, null);
});

test('safety net: ProfileAvailable, a cached tenant, forced enrollment or "no profile assigned" all mean check by hand', async () => {
  const cases = {
    profileAvailable: POLICY(REAL_POLICY_JSON, 1),
    cachedDomain: POLICY(JSON.stringify({ PolicyDownloadDate: '2026-11-18T01:00:00Z', CloudAssignedTenantDomain: 'contoso.onmicrosoft.com' })),
    forced: POLICY(JSON.stringify({ PolicyDownloadDate: '2026-11-18T01:00:00Z', CloudAssignedAadServerData: JSON.stringify({ ZeroTouchConfig: { ForcedEnrollment: 1 } }) })),
    registeredNoProfile: POLICY(JSON.stringify({ ErrorCode: 815, ErrorReason: 'ZtdDeviceHasNoAssignedProfile', PolicyDownloadDate: '2026-11-18T01:00:00Z' })),
  };
  for (const [name, cache] of Object.entries(cases)) {
    const { deps } = fakeIo({ registry: (key) => (key === POLICY_KEY ? cache : {}) });
    const r = await runMdmCheck(deps);
    assert.equal(r.status, 'ghost', name);
    assert.equal(r.safetyNet, 'tenant-evidence', name);
  }
});

test('safety net: no answer from Microsoft, or one from before this boot, is "clean, unconfirmed"', async () => {
  const none = fakeIo({ registry: () => ({}) });
  const r1 = await runMdmCheck(none.deps);
  assert.equal(r1.status, 'unconfirmed');
  assert.equal(none.log.progress.filter((p) => p.step === 'confirm').length, 10, 'waits up to 30 s more for the answer');
  assert.equal(mdmVerdict(r1).status, null);
  assert.match(mdmVerdict(r1).summary, /no record of asking Microsoft/);

  const stale = fakeIo();
  const r2 = await runMdmCheck({ ...stale.deps, bootTime: Date.parse('2026-11-18T08:00:00Z') });
  assert.equal(r2.status, 'unconfirmed');
  assert.match(r2.confirmation, /before this boot/);
});

test("safety net: Microsoft's answer arriving during the extra wait confirms clean", async () => {
  let reads = 0;
  const { deps } = fakeIo({ registry: (key) => (key === POLICY_KEY ? (++reads >= 3 ? POLICY() : {}) : {}) });
  const r = await runMdmCheck(deps);
  assert.equal(r.status, 'clean');
});

test('safety net: an unreadable registry is "can\'t verify", never clean', async () => {
  const { log, deps } = fakeIo({ registry: () => null });
  const r = await runMdmCheck(deps);
  assert.equal(r.status, 'unverified');
  assert.equal(r.registryReadable, false);
  assert.equal(log.pings, 0, 'stops before the network gate');
  assert.match(mdmVerdict(r).summary, /registry couldn't be read/);
});

test('policy cache parsing: the real "not registered" record from a Windows 11 VM', () => {
  const c = parsePolicyCache(POLICY());
  assert.deepEqual(c, {
    profileAvailable: false,
    errorCode: 807,
    errorReason: 'ZtdDeviceIsNotRegistered',
    downloadedAt: '2026-11-17T23:34:49Z',
    tenantId: null,
    tenantDomain: null,
    tenantUpn: null,
    forcedEnrollment: false,
  });
  assert.deepEqual(tenantEvidence({ CloudAssignedTenantId: '', CloudAssignedTenantDomain: '', IsAutoPilotDisabled: 0 }, c), [], 'empty values are not evidence');
  assert.equal(confirmClean(c, BOOT).confirmed, true);
  assert.equal(parsePolicyCache({ PolicyJsonCache: 'not json' }).errorCode, null);
  assert.equal(parsePolicyCache(null), null);
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

// ---------------------------------------------------------------- security inventory

const { parseTpmtool, parseManageBde, secureBootState, collectSecurity } = require('../src/main/intake/security');

const TPMTOOL = ['-TPM Present: True', '-TPM Version: 2.0', '-TPM Manufacturer ID: INTC', '-TPM Manufacturer Full Name: Intel', '-TPM Manufacturer Version: 600.18.0.0', '-PPI Version: 1.3', '-Is Initialized: True', '-Ready For Storage: True'].join('\r\n');
const BDE = [
  'BitLocker Drive Encryption: Configuration Tool version 10.0.22621',
  'Volume C: [Windows]',
  '[OS Volume]',
  '',
  '    Size:                 475.83 GB',
  '    Conversion Status:    Used Space Only Encrypted',
  '    Percentage Encrypted: 100.0%',
  '    Encryption Method:    XTS-AES 128',
  '    Protection Status:    Protection Off',
  '    Key Protectors:',
  '        TPM',
].join('\r\n');

test('security inventory: tpmtool, manage-bde and the Secure Boot registry key', async () => {
  assert.deepEqual(parseTpmtool(TPMTOOL), { present: true, version: '2.0', manufacturer: 'Intel', firmware: '600.18.0.0', ready: true });
  assert.equal(parseTpmtool('tpmtool is not recognized'), null);
  assert.deepEqual(parseManageBde(BDE), { conversion: 'Used Space Only Encrypted', percentEncrypted: 100, protection: 'Protection Off', method: 'XTS-AES 128', encrypted: true });
  assert.equal(parseManageBde(BDE.replace('Used Space Only Encrypted', 'Fully Decrypted')).encrypted, false);
  assert.equal(secureBootState({ UEFISecureBootEnabled: 1 }), 'enabled');
  assert.equal(secureBootState({ UEFISecureBootEnabled: 0 }), 'disabled');
  assert.equal(secureBootState(null), 'unsupported');

  const exec = (cmd, _a, _o, cb) => cb(null, cmd === 'tpmtool' ? TPMTOOL : BDE);
  const sec = await collectSecurity({ platform: 'win32', exec, read: async () => ({ UEFISecureBootEnabled: 1 }) });
  assert.deepEqual([sec.secureBoot, sec.tpm.version, sec.bitLocker.protection], ['enabled', '2.0', 'Protection Off']);
  assert.equal(await collectSecurity({ platform: 'darwin' }), null);
});

// ---------------------------------------------------------------- Defender scan

const { EventEmitter } = require('node:events');
const { runDefenderScan, interpretScan, malwareVerdict, SCRIPT } = require('../src/main/intake/defender');

const RAW_CLEAN = {
  available: true,
  update: { ok: true, error: null },
  defender: { signatures: '1.421.100.0', engine: '1.1.24090.11' },
  auditMode: true,
  durationSeconds: 95,
  filesScanned: '48,213',
  threats: [],
};
const THREAT = (name, newThisScan) => ({ name, severityId: 5, newThisScan, detectedAt: '2026-11-18T10:00:00Z', resources: ['file:_C:\\Users\\x\\bad.exe'] });

test('Defender results follow v1: any detection (even an old one) means infected', () => {
  const clean = interpretScan(RAW_CLEAN);
  assert.deepEqual([clean.status, clean.filesScanned, clean.definitionsUpdated], ['clean', 48213, true]);
  const old = interpretScan({ ...RAW_CLEAN, threats: [THREAT('Trojan:Win32/Old', false)] });
  assert.equal(old.status, 'infected', 'historical detections count, as in v1');
  assert.equal(old.newThreats, 0);
  assert.equal(old.threats[0].severity, 'Severe');
  assert.equal(interpretScan({ available: false, error: 'not installed' }).status, 'unavailable');
  assert.equal(interpretScan({ ...RAW_CLEAN, scanError: 'boom' }).status, 'error');
});

test('malware verdict: recorded-not-failed by default, a site setting can fail it', () => {
  const infected = interpretScan({ ...RAW_CLEAN, threats: [THREAT('PUA:Win32/Bloat', true), THREAT('PUA:Win32/Bloat', true)] });
  const v = malwareVerdict(infected);
  assert.equal(v.status, 'pass');
  assert.match(v.summary, /Threats found: 1 \(PUA:Win32\/Bloat\)\. Documented and left in place.*Recorded, not failed/);
  assert.equal(malwareVerdict(infected, { malwareFails: true }).status, 'fail');
  assert.match(malwareVerdict(interpretScan(RAW_CLEAN)).summary, /^Clean: .*48,213 files/);
  const stale = malwareVerdict(interpretScan({ ...RAW_CLEAN, update: { ok: false, error: 'no network' } }));
  assert.match(stale.summary, /definitions NOT updated \(no network\)/);
  assert.equal(malwareVerdict({ status: 'error', message: 'x' }).status, null);
});

test('Defender run: streams progress, parses the result line, survives junk output', async () => {
  const progress = [];
  let args;
  const spawnFn = (cmd, a) => {
    args = [cmd, a];
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('WARNING: something\r\n{"event":"progress","step":"update"}\r\n{"event":"prog'));
      child.stdout.emit('data', Buffer.from(`ress","step":"scan"}\r\n${JSON.stringify({ event: 'result', data: RAW_CLEAN })}`));
      child.emit('close', 0);
    });
    return child;
  };
  const r = await runDefenderScan({ spawnFn, onProgress: (p) => progress.push(p.step) });
  assert.deepEqual(progress, ['update', 'scan']);
  assert.equal(r.status, 'clean');
  assert.equal(args[0], 'powershell.exe');
  assert.equal(Buffer.from(args[1][args[1].length - 1], 'base64').toString('utf16le'), SCRIPT, 'script passed as -EncodedCommand');
});

test('the scan script keeps v1 audit-mode settings and never removes anything', () => {
  assert.match(SCRIPT, /Set-MpPreference -PUAProtection AuditMode/);
  assert.match(SCRIPT, /-HighThreatDefaultAction 9 -SevereThreatDefaultAction 9 -ModerateThreatDefaultAction 9 -LowThreatDefaultAction 9/);
  assert.match(SCRIPT, /Update-MpSignature/);
  assert.match(SCRIPT, /Start-MpScan -ScanType QuickScan/);
  assert.doesNotMatch(SCRIPT, /Remove-MpThreat|Remove-MpPreference/, 'report only; settings are left in audit mode like v1');
});
