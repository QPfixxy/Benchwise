'use strict';

// "Test drive" port test. Any flash drive is prepared once (a marker file and
// a 64 MiB reference file are added; nothing is erased). Plugged into each
// port in turn, Qudit then:
//   1. identifies the physical port + negotiated link speed (usbtree.js)
//   2. reads the reference file and checks its SHA-256: proves data crossed
//      that port intact, and measures uncached read speed (fresh mount)
//   3. writes + fsyncs a temp file to measure write speed, then deletes it
//   4. ejects the drive so it's safe to pull and move to the next port

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFile } = require('node:child_process');

const MARKER = 'QUDIT-TEST-DRIVE.json';
const DATA_DIR = 'QUDIT-TEST-DRIVE';
const READ_FILE = 'read-test.bin';
const WRITE_FILE = 'write-test.tmp';
const READ_BYTES = 64 * 1024 * 1024;
const WRITE_BYTES = 32 * 1024 * 1024;
const CHUNK = 4 * 1024 * 1024;

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || err?.message || '') }),
    );
  });
}

/** Rejects if `p` doesn't settle in time (an empty card reader can stall fs calls on Windows). */
function within(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error('timeout')), ms)))]).finally(() => clearTimeout(t));
}

// ------------------------------------------------------------------ volumes

/** Mounted, user-visible volumes that could be a flash drive. System volumes excluded. */
async function candidateMounts() {
  const dirs = async (root) => {
    try {
      const entries = await fsp.readdir(root, { withFileTypes: true });
      // On macOS the boot volume appears in /Volumes as a symlink to "/".
      return entries.filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => path.join(root, e.name));
    } catch {
      return [];
    }
  };
  if (process.platform === 'darwin') return dirs('/Volumes');
  if (process.platform === 'linux') {
    const user = os.userInfo().username;
    const nested = await Promise.all(['/media', '/run/media'].map(async (r) => [...(await dirs(path.join(r, user))), ...(await dirs(r))]));
    return [...new Set([...nested.flat(), ...(await dirs('/mnt'))])].filter((p) => p !== path.join('/media', user) && p !== path.join('/run/media', user));
  }
  if (process.platform === 'win32') {
    const letters = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`);
    const ok = await Promise.all(letters.map((p) => within(fsp.access(p), 1500).then(() => true, () => false)));
    return letters.filter((_, i) => ok[i]);
  }
  return [];
}

/**
 * Only external/removable volumes: what may be offered for "make test drive".
 * (System volumes such as macOS Recovery or an internal D: must never be.)
 */
async function externalMounts() {
  const mounts = await candidateMounts();
  if (process.platform === 'darwin') {
    const checks = await Promise.all(
      mounts.map(async (m) => {
        if (path.basename(m).startsWith('.')) return false;
        const { ok, out } = await run('diskutil', ['info', '-plist', m], 10000);
        return ok && /<key>Internal<\/key>\s*<false\/>/.test(out);
      }),
    );
    return mounts.filter((_, i) => checks[i]);
  }
  if (process.platform === 'win32') {
    const { out } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-Volume | Where-Object DriveLetter | ForEach-Object { $d = Get-Partition -DriveLetter $_.DriveLetter -ErrorAction SilentlyContinue | Get-Disk -ErrorAction SilentlyContinue; \"$($_.DriveLetter)|$($d.BusType)|$($_.DriveType)\" }",
      ],
      30000,
    );
    const external = new Set(
      out
        .split(/\r?\n/)
        .map((l) => l.trim().split('|'))
        .filter(([letter, bus, type]) => letter && (/usb/i.test(bus) || /removable/i.test(type)))
        .map(([letter]) => `${letter.toUpperCase()}:\\`),
    );
    return mounts.filter((m) => external.has(m));
  }
  return mounts; // Linux: /media and /run/media are removable mounts by convention
}

async function readMarker(mount) {
  try {
    const m = JSON.parse(await within(fsp.readFile(path.join(mount, MARKER), 'utf8'), 2000));
    if (m?.qudit !== 'test-drive' || !/^[0-9a-f]{64}$/.test(m.sha256)) return null;
    return m;
  } catch {
    return null;
  }
}

async function volumeInfo(mount) {
  let freeBytes = null;
  let totalBytes = null;
  try {
    const s = await within(fsp.statfs(mount), 2000);
    freeBytes = s.bavail * s.bsize;
    totalBytes = s.blocks * s.bsize;
  } catch {
    /* unknown */
  }
  return { mount, label: path.basename(mount) || mount, freeBytes, totalBytes };
}

/** Volumes for the "prepare a test drive" picker. */
async function listVolumes(mountsFn = externalMounts) {
  const mounts = await mountsFn();
  return Promise.all(
    mounts.map(async (m) => ({ ...(await volumeInfo(m)), isTestDrive: Boolean(await readMarker(m)) })),
  );
}

async function findTestDrives(mountsFn = candidateMounts) {
  const mounts = await mountsFn();
  const found = await Promise.all(mounts.map(async (m) => ({ mount: m, marker: await readMarker(m) })));
  return found.filter((d) => d.marker);
}

/** Adds the marker + reference file. Does not touch anything else on the drive. */
async function prepareDrive(mount, { mountsFn = externalMounts, bytes = READ_BYTES } = {}) {
  const allowed = await mountsFn();
  if (!allowed.includes(mount)) throw new Error('That volume is not available (only external drives can be prepared).');
  const info = await volumeInfo(mount);
  if (info.freeBytes !== null && info.freeBytes < bytes + WRITE_BYTES + 8 * 1024 * 1024) {
    throw new Error(`Not enough free space: need about ${Math.ceil((bytes + WRITE_BYTES) / 1e6) + 8} MB.`);
  }
  const dir = path.join(mount, DATA_DIR);
  await fsp.mkdir(dir, { recursive: true });
  const hash = crypto.createHash('sha256');
  const fh = await fsp.open(path.join(dir, READ_FILE), 'w');
  try {
    for (let written = 0; written < bytes; written += CHUNK) {
      const buf = crypto.randomBytes(Math.min(CHUNK, bytes - written));
      hash.update(buf);
      await fh.write(buf);
    }
    await fh.sync();
  } finally {
    await fh.close();
  }
  const marker = {
    qudit: 'test-drive',
    version: 1,
    id: crypto.randomUUID(),
    created: new Date().toISOString(),
    readFile: `${DATA_DIR}/${READ_FILE}`,
    bytes,
    sha256: hash.digest('hex'),
    note: 'Used by Qudit to test USB ports. Safe to delete the QUDIT-TEST-DRIVE folder and this file.',
  };
  await fsp.writeFile(path.join(mount, MARKER), JSON.stringify(marker, null, 2));
  return marker;
}

// ------------------------------------------------------------------ benchmark

const mbps = (bytes, ms) => (ms > 0 ? Math.round((bytes / 1e6 / (ms / 1000)) * 10) / 10 : null);

async function benchmark(mount, marker) {
  const result = { verified: false, readMBps: null, writeMBps: null, error: null };
  try {
    // Read + verify. The drive was just mounted, so this read comes from the
    // device rather than the OS cache.
    const file = path.join(mount, ...String(marker.readFile || `${DATA_DIR}/${READ_FILE}`).split('/'));
    const hash = crypto.createHash('sha256');
    let total = 0;
    const t0 = performance.now();
    const rh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      for (;;) {
        const { bytesRead } = await rh.read(buf, 0, CHUNK, null);
        if (!bytesRead) break;
        hash.update(buf.subarray(0, bytesRead));
        total += bytesRead;
      }
    } finally {
      await rh.close();
    }
    result.readMBps = mbps(total, performance.now() - t0);
    result.verified = total === marker.bytes && hash.digest('hex') === marker.sha256;
    if (!result.verified) result.error = 'Reference file did not match: data corrupted on this port, cable or drive.';

    // Write (fsync so the number reflects the device, not the cache).
    const wfile = path.join(mount, DATA_DIR, WRITE_FILE);
    const data = crypto.randomBytes(CHUNK);
    const t1 = performance.now();
    const wh = await fsp.open(wfile, 'w');
    try {
      for (let w = 0; w < WRITE_BYTES; w += CHUNK) await wh.write(data);
      await wh.sync();
    } finally {
      await wh.close();
    }
    result.writeMBps = mbps(WRITE_BYTES, performance.now() - t1);
    await fsp.rm(wfile, { force: true });
  } catch (err) {
    result.error = result.error || `I/O error: ${err.message}`;
  }
  return result;
}

// ------------------------------------------------------------------ eject

async function linuxDeviceFor(mount) {
  try {
    const lines = (await fsp.readFile('/proc/mounts', 'utf8')).split('\n');
    for (const l of lines) {
      const [dev, mnt] = l.split(' ');
      if (mnt && mnt.replace(/\\040/g, ' ') === mount) return dev;
    }
  } catch {
    /* none */
  }
  return null;
}

async function ejectVolume(mount) {
  if (process.platform === 'darwin') return (await run('diskutil', ['eject', mount])).ok;
  if (process.platform === 'linux') {
    const dev = await linuxDeviceFor(mount);
    if (dev && (await run('udisksctl', ['unmount', '-b', dev])).ok) {
      await run('udisksctl', ['power-off', '-b', dev.replace(/\d+$/, '')]);
      return true;
    }
    return (await run('umount', [mount])).ok;
  }
  if (process.platform === 'win32') {
    if (!/^[D-Z]:\\$/.test(mount)) return false;
    const drive = mount.slice(0, 2);
    return (
      await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(New-Object -ComObject Shell.Application).Namespace(17).ParseName('${drive}').InvokeVerb('Eject')`,
      ])
    ).ok;
  }
  return false;
}

// ------------------------------------------------------------------ watcher

/**
 * Polled by the UI. A drive counts as "inserted" only when it appears after
 * start(), so a drive already plugged in must be re-plugged (that also
 * guarantees the read isn't served from cache).
 */
class PortWatcher {
  constructor(deps = {}) {
    this.findTestDrives = deps.findTestDrives || (() => findTestDrives());
    this.snapshotUsb = deps.snapshotUsb || require('../hardware/usbtree').snapshotUsb;
    this.identifyStick = deps.identifyStick || require('../hardware/usbtree').identifyStick;
    this.benchmark = deps.benchmark || benchmark;
    this.eject = deps.eject || ejectVolume;
    this.reset();
  }

  reset() {
    this.started = false;
    this.present = new Set();
    this.waitingRemoval = new Set();
    this.baseline = [];
    this.stick = null;
    this.running = null;
    this.results = [];
    this.lastError = null;
    this.baselineStale = false;
  }

  async start() {
    this.reset();
    const [drives, baseline] = await Promise.all([this.findTestDrives(), this.snapshotUsb()]);
    for (const d of drives) {
      this.present.add(d.mount);
      this.waitingRemoval.add(d.mount);
    }
    this.baseline = baseline;
    this.started = true;
    return this.state();
  }

  stop() {
    this.started = false;
  }

  async poll() {
    if (!this.started) return this.state();
    const drives = await this.findTestDrives();
    const mounts = new Set(drives.map((d) => d.mount));
    for (const m of [...this.present]) {
      if (!mounts.has(m)) {
        this.present.delete(m);
        this.waitingRemoval.delete(m);
        this.baselineStale = true;
      }
    }
    if (this.baselineStale && !this.running && !this.present.size) {
      this.baselineStale = false;
      this.baseline = await this.snapshotUsb();
    }
    for (const d of drives) {
      if (this.present.has(d.mount) || this.running) continue;
      this.present.add(d.mount);
      this.running = { mount: d.mount, phase: 'Identifying port…', startedAt: new Date().toISOString() };
      this.#runInsertion(d).catch((err) => (this.lastError = err.message));
    }
    return this.state();
  }

  async #runInsertion(drive) {
    try {
      const after = await this.snapshotUsb();
      const dev = this.identifyStick(this.baseline, after, this.stick);
      if (dev && !this.stick) this.stick = { serial: dev.serial, vendorId: dev.vendorId, productId: dev.productId };
      this.running.phase = 'Verifying data and measuring speed… do not unplug';
      const bench = await this.benchmark(drive.mount, drive.marker);
      this.running.phase = 'Ejecting…';
      const ejected = await this.eject(drive.mount);
      const n = this.results.length + 1;
      this.results.push({
        n,
        portKey: dev?.location || `insertion-${n}`,
        location: dev?.location || null,
        device: dev?.name || null,
        speed: dev?.speed || null,
        speedMbps: dev?.speedMbps ?? null,
        ...bench,
        ejected,
        at: new Date().toISOString(),
      });
      this.baseline = after.filter((d) => d !== dev);
    } finally {
      this.running = null;
    }
  }

  state() {
    const ports = new Map();
    for (const r of this.results) ports.set(r.portKey, r); // latest result per port wins
    return {
      started: this.started,
      present: [...this.present],
      waitingRemoval: [...this.waitingRemoval],
      running: this.running,
      results: this.results,
      ports: [...ports.values()],
      lastError: this.lastError,
    };
  }
}

module.exports = {
  PortWatcher,
  listVolumes,
  findTestDrives,
  prepareDrive,
  benchmark,
  ejectVolume,
  candidateMounts,
  externalMounts,
  MARKER,
  READ_BYTES,
};
