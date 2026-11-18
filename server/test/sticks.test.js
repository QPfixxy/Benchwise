'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const yazl = require('yazl');
const sticks = require('../src/sticks');
const { makeStick } = require('../src/apply');

const GB = 1e9;
// Shaped like `lsblk -J -b -o NAME,PATH,SIZE,...` on a VM with one USB stick.
const LSBLK = {
  blockdevices: [
    { name: 'loop0', path: '/dev/loop0', size: 4096, type: 'loop', rm: false, hotplug: false, mountpoints: ['/snap/bare/5'] },
    { name: 'sda', path: '/dev/sda', size: 512 * GB, type: 'disk', tran: 'sata', rm: false, hotplug: false, mountpoints: [null], children: [{ name: 'sda2', path: '/dev/sda2', type: 'part', mountpoints: ['/'] }] },
    { name: 'sdb', path: '/dev/sdb', size: 61.5 * GB, model: '3.2Gen1', vendor: 'SanDisk', serial: '0401abcd', type: 'disk', tran: 'usb', rm: true, hotplug: true, mountpoints: [null], children: [{ name: 'sdb1', path: '/dev/sdb1', type: 'part', label: 'OLDSTICK', mountpoints: ['/media/test/OLDSTICK'] }] },
    { name: 'sdc', path: '/dev/sdc', size: 0.5 * GB, model: 'Tiny', type: 'disk', tran: 'usb', rm: true, hotplug: true, mountpoints: [null] },
    { name: 'sdd', path: '/dev/sdd', size: 128 * GB, model: 'Boot USB', type: 'disk', tran: 'usb', rm: true, hotplug: true, mountpoints: [null], children: [{ name: 'sdd1', type: 'part', mountpoints: ['/boot/efi'] }] },
    { name: 'sr0', path: '/dev/sr0', size: 2 * GB, type: 'rom', rm: true, mountpoints: [null] },
  ],
};

test('drives: only whole, removable, non-system disks of a sensible size qualify', () => {
  const d = Object.fromEntries(sticks.eligibleDrives(LSBLK).map((x) => [x.name, x]));
  assert.equal(d.loop0, undefined);
  assert.equal(d.sr0, undefined);
  assert.equal(d.sda.eligible, false);
  assert.equal(d.sda.why, 'not a removable/USB drive');
  assert.equal(d.sdb.eligible, true);
  assert.deepEqual([d.sdb.model, d.sdb.size, d.sdb.serial, d.sdb.label, d.sdb.mounted], ['SanDisk 3.2Gen1', '61.5 GB', '0401abcd', 'OLDSTICK', ['/media/test/OLDSTICK']]);
  assert.equal(d.sdc.why, 'smaller than 1 GB');
  assert.equal(d.sdd.why, 'holds a system filesystem', 'a USB disk the server booted from is never offered');
});

test('site.cmd: CRLF, the settings sticks need, and nothing batch-unsafe', () => {
  const cmd = sticks.buildSiteCmd({ serverUrl: 'https://172.16.0.2', key: 'bws_abc-DEF_123', fingerprint: 'AA:BB', wifiName: 'FLOOR', checkHost: '172.16.0.2' });
  assert.ok(cmd.includes('\r\n') && !/[^\r]\n/.test(cmd), 'Windows line endings');
  for (const line of ['set "WIFI_NAME=FLOOR"', 'set "CHECK_HOST=172.16.0.2"', 'set "BENCHWISE_SERVER_URL=https://172.16.0.2"', 'set "BENCHWISE_SERVER_KEY=bws_abc-DEF_123"', 'set "BENCHWISE_SERVER_FINGERPRINT=AA:BB"']) assert.ok(cmd.includes(line), line);
  const wired = sticks.buildSiteCmd({ serverUrl: 'https://s', key: 'k', fingerprint: null, wifiName: null, checkHost: 's' });
  assert.match(wired, /rem No floor Wi-Fi set/);
  assert.match(wired, /rem The server uses a company certificate/);
  assert.throws(() => sticks.buildSiteCmd({ serverUrl: 'https://s', key: 'k', wifiName: 'A&B' }), /batch file/);
  assert.throws(() => sticks.buildSiteCmd({ serverUrl: 'https://s"&calc', key: 'k' }), /batch file/);
});

test('stick builds: only Benchwise 2.5.0-beta.2 or later (older ones have no outbox)', () => {
  const { compareVersions: cmp, checkStickVersion: check, versionFromFileName: fromName } = sticks;
  assert.deepEqual(['2.5.0-beta.1', '2.5.0-beta.2', '2.5.0-beta.10', '2.5.0-rc.1', '2.5.0', '2.5.1', '3.0.0'].map((v) => cmp(v, '2.5.0-beta.2')), [-1, 0, 1, 1, 1, 1, 1]);
  assert.equal(cmp('2.4.0', '2.5.0-beta.2'), -1);
  assert.equal(cmp('v2.10.0', '2.9.0'), 1);
  assert.equal(cmp('not-a-version', '2.5.0'), null);
  assert.throws(() => check('2.5.0-beta.1'), /can't send reports.*2\.5\.0-beta\.2 or later/);
  assert.throws(() => check('2.4.0'), /can't send reports/);
  assert.throws(() => check(null), /Can't tell which Benchwise version/);
  for (const v of ['2.5.0-beta.2', '2.5.0', '2.6.0']) assert.doesNotThrow(() => check(v));
  assert.equal(fromName('Benchwise-2.5.0-beta.2-win-x64.zip'), '2.5.0-beta.2');
  assert.equal(fromName('my-copy.zip'), null);
});

function makeZip(file, entries) {
  return new Promise((resolve) => {
    const z = new yazl.ZipFile();
    for (const [name, data] of entries) z.addBuffer(Buffer.from(data), name);
    z.outputStream.pipe(fs.createWriteStream(file)).on('close', resolve);
    z.end();
  });
}

test('Benchwise build ZIPs: must be a stick build; unsafe paths refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-zip-'));
  const good = path.join(dir, 'good.zip');
  await makeZip(good, [['Benchwise.exe', 'MZ'], ['LAUNCH.CMD', '@echo off'], ['resources/app.asar', 'x']]);
  assert.deepEqual(await sticks.inspectZip(good), { files: 3, unpackedBytes: 4 + 9 + 1 - 2 });
  const notStick = path.join(dir, 'other.zip');
  await makeZip(notStick, [['Benchwise.exe', 'MZ']]);
  await assert.rejects(sticks.inspectZip(notStick), /missing launch\.cmd/);
  const slip = path.join(dir, 'slip.zip');
  // yazl won't write a "../" name, so write a same-length one and patch the bytes.
  await makeZip(slip, [['Benchwise.exe', 'MZ'], ['LAUNCH.CMD', 'x'], ['xx/xx/etc/cron.d/evil', 'x']]);
  fs.writeFileSync(slip, Buffer.from(fs.readFileSync(slip).toString('latin1').replaceAll('xx/xx/', '../../'), 'latin1'));
  await assert.rejects(sticks.inspectZip(slip), /Unsafe path/);
  fs.writeFileSync(path.join(dir, 'junk.zip'), 'not a zip');
  await assert.rejects(sticks.inspectZip(path.join(dir, 'junk.zip')), /Not a valid ZIP/);
});

test('GitHub release download: newest stick build, checksum verified, pre-releases optional', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-rel-'));
  const src = path.join(dir, 'src.zip');
  await makeZip(src, [['Benchwise.exe', 'MZ'], ['LAUNCH.CMD', '@echo off']]);
  const bytes = fs.readFileSync(src);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const releases = (digest) => [
    { tag_name: 'v2.5.0-beta.2', prerelease: true, draft: false, assets: [{ name: 'Benchwise-2.5.0-beta.2-win-x64.zip', browser_download_url: 'https://dl/beta', digest }] },
    { tag_name: 'v2.4.0', prerelease: false, draft: false, assets: [{ name: 'Benchwise-2.4.0-windows-portable.exe', browser_download_url: 'https://dl/exe' }] },
  ];
  const fakeFetch = (digest) => async (url) =>
    url.includes('api.github.com') ? { ok: true, json: async () => releases(digest) } : { ok: true, arrayBuffer: async () => bytes };
  const dest = path.join(dir, 'app.zip');
  const meta = await sticks.fetchRelease({ includePrerelease: true, dest, fetchImpl: fakeFetch(`sha256:${sha}`) });
  assert.deepEqual([meta.version, meta.verified, meta.sha256, fs.existsSync(dest)], ['2.5.0-beta.2', true, sha, true]);
  await assert.rejects(sticks.fetchRelease({ includePrerelease: true, dest, fetchImpl: fakeFetch(`sha256:${'0'.repeat(64)}`) }), /Checksum mismatch/);
  await assert.rejects(sticks.fetchRelease({ includePrerelease: false, dest, fetchImpl: fakeFetch(null) }), /No release .* stick build.*pre-releases/);
  const oldOnly = async (url) => (url.includes('api.github.com') ? { ok: true, json: async () => [{ tag_name: 'v2.5.0-beta.1', prerelease: true, assets: [{ name: 'Benchwise-2.5.0-beta.1-win-x64.zip', browser_download_url: 'https://dl/old' }] }] } : assert.fail('an old build is never downloaded'));
  await assert.rejects(sticks.fetchRelease({ includePrerelease: true, dest, fetchImpl: oldOnly }), /2\.5\.0-beta\.1, which can't send reports/);
});

// ---------------------------------------------------------------- the root helper's stick job

function stickHarness({ lsblk = LSBLK } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-stickjob-'));
  const paths = { sticks: path.join(root, 'sticks'), mountBase: path.join(root, 'run') };
  fs.mkdirSync(paths.sticks);
  fs.mkdirSync(paths.mountBase);
  fs.writeFileSync(path.join(paths.sticks, 'app.zip'), 'zip');
  const ran = [];
  const run = (cmd, args) => {
    ran.push([cmd, ...args].join(' '));
    if (cmd === 'lsblk') return JSON.stringify(lsblk);
    if (cmd === 'unzip') fs.writeFileSync(path.join(args[args.length - 1], 'Benchwise.exe'), 'MZ'); // pretend to unpack
    return '';
  };
  const req = { id: crypto.randomUUID(), type: 'stick', device: 'sdb', serial: '0401abcd', siteCmd: '@echo off\r\n', wifiXml: '<WLANProfile/>', readme: 'README' };
  return { paths, run, ran, req };
}

test('stick job: unmount, wipe, partition, exFAT, unpack, settings, unmount, in that order', () => {
  const h = stickHarness();
  const written = {};
  const origWrite = fs.writeFileSync;
  const steps = [];
  const res = makeStick(h.req, {
    paths: h.paths,
    run: (cmd, args, opts) => {
      if (cmd === 'umount' && args[0].includes('benchwise-stick-')) {
        // Capture what was written onto the "stick" before it's cleaned up.
        for (const f of ['Benchwise/site.cmd', 'Benchwise/wifi.xml', 'README.TXT', 'Benchwise/Benchwise.exe']) written[f] = fs.readFileSync(path.join(args[0], f), 'utf8');
      }
      if (cmd === 'sfdisk') assert.equal(opts.input, 'label: dos\n,,7\n');
      return h.run(cmd, args);
    },
    progress: (s) => steps.push(s),
  });
  assert.equal(origWrite, fs.writeFileSync);
  assert.deepEqual(res, { ok: true, drive: 'SanDisk 3.2Gen1 (61.5 GB)' });
  const cmds = h.ran.map((c) => c.split(' ')[0]);
  assert.deepEqual(cmds, ['lsblk', 'umount', 'wipefs', 'sfdisk', 'udevadm', 'mkfs.exfat', 'mount', 'unzip', 'sync', 'umount']);
  assert.ok(h.ran.includes('umount /media/test/OLDSTICK'), 'the old partition is unmounted first');
  assert.ok(h.ran.includes('wipefs --all --force /dev/sdb'));
  assert.ok(h.ran.includes('mkfs.exfat -L BENCHWISE /dev/sdb1'));
  assert.deepEqual(written, { 'Benchwise/site.cmd': '@echo off\r\n', 'Benchwise/wifi.xml': '<WLANProfile/>', 'README.TXT': 'README', 'Benchwise/Benchwise.exe': 'MZ' });
  assert.deepEqual(steps, ['Preparing the drive', 'Formatting (exFAT)', 'Copying Benchwise', 'Writing the settings', 'Finishing']);
  assert.deepEqual(fs.readdirSync(h.paths.mountBase), [], 'temporary mount folder removed');
});

test('stick job: a drive open in another program is refused, naming it, before anything is erased', () => {
  const h = stickHarness();
  const run = (cmd, args) => {
    if (cmd === 'umount') throw Object.assign(new Error('Command failed'), { stderr: 'target is busy' });
    if (cmd === 'fuser') return ' 999999999';
    return h.run(cmd, args);
  };
  assert.throws(() => makeStick(h.req, { paths: h.paths, run }), /open in another program \(pid 999999999\).*Nothing was erased/);
  assert.ok(!h.ran.some((c) => /^(wipefs|sfdisk|mkfs)/.test(c)));
});

test('stick job: refuses before erasing anything when the drive is wrong', () => {
  for (const [label, change, msg] of [
    ['swapped drive', { serial: 'someone-else' }, /different drive/],
    ['internal disk', { device: 'sda' }, /can't be used: not a removable/],
    ['boot USB', { device: 'sdd', serial: null }, /holds a system filesystem/],
    ['unplugged', { device: 'sdz' }, /no longer plugged in/],
    ['injection', { device: 'sdb; rm -rf /' }, /Not a drive name/],
    ['path', { device: '../sda' }, /Not a drive name/],
  ]) {
    const h = stickHarness();
    assert.throws(() => makeStick({ ...h.req, ...change }, { paths: h.paths, run: h.run }), msg, label);
    assert.ok(!h.ran.some((c) => /^(wipefs|sfdisk|mkfs)/.test(c)), `${label}: nothing erased`);
  }
});

test('stick job: no Benchwise build, or oversized files, are refused up front', () => {
  const h = stickHarness();
  fs.rmSync(path.join(h.paths.sticks, 'app.zip'));
  assert.throws(() => makeStick(h.req, { paths: h.paths, run: h.run }), /No Benchwise build/);
  const h2 = stickHarness();
  assert.throws(() => makeStick({ ...h2.req, siteCmd: 'x'.repeat(9000) }, { paths: h2.paths, run: h2.run }), /oversized siteCmd/);
  assert.equal(h2.ran.length, 0);
});
