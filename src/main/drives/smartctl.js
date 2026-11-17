'use strict';

// Finds and runs smartctl (smartmontools). Every call is an async child
// process, so a slow or hung drive can only delay its own result.
//
// Where smartctl comes from, in order:
//   1. Bundled with the packaged app:  <resources>/smartctl/
//   2. Dev checkout after `npm run vendor:smartctl`:  vendor/smartctl/<target>/
//   3. Installed on the system (PATH, Homebrew, the Windows installer folder)

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { parseDrive, evaluateDrives, driveLine, permissionDenied } = require('./health');

const EXE = process.platform === 'win32' ? 'smartctl.exe' : 'smartctl';
const SCAN_TIMEOUT_MS = 20000;
const DRIVE_TIMEOUT_MS = 30000;

function vendorTarget(platform = process.platform, arch = process.arch) {
  return platform === 'darwin' ? 'darwin-universal' : `${platform}-${arch}`;
}

function candidates({ resourcesPath = process.resourcesPath, appRoot = path.join(__dirname, '..', '..', '..'), platform = process.platform, env = process.env } = {}) {
  const list = [];
  if (resourcesPath) list.push({ file: path.join(resourcesPath, 'smartctl', EXE), source: 'bundled' });
  list.push({ file: path.join(appRoot, 'vendor', 'smartctl', vendorTarget(platform), EXE), source: 'bundled' });
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  if (platform === 'win32') {
    dirs.push(path.join(env.ProgramFiles || 'C:\\Program Files', 'smartmontools', 'bin'));
  } else {
    // Apps started from Finder/Dock don't get the shell's PATH.
    dirs.push('/usr/sbin', '/sbin', '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin');
  }
  for (const d of dirs) list.push({ file: path.join(d, EXE), source: 'system' });
  return list;
}

let located;
function locateSmartctl(opts) {
  if (located !== undefined && !opts) return located;
  const found = candidates(opts).find((c) => {
    try {
      return fs.statSync(c.file).isFile();
    } catch {
      return false;
    }
  });
  if (!opts) located = found || null;
  return found || null;
}

/** Runs smartctl; resolves with parsed JSON (smartctl exits non-zero on drive problems, by design). */
function runJson(bin, args, timeout) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (err && err.killed) return resolve({ error: `smartctl timed out after ${Math.round(timeout / 1000)} s` });
      if (err && typeof err.code === 'string') return resolve({ error: err.message });
      try {
        resolve({ json: JSON.parse(stdout) });
      } catch {
        resolve({ error: `smartctl gave no readable output${err ? ` (exit ${err.code})` : ''}` });
      }
    });
  });
}

/** Linux: a /dev/sdX behind USB has "/usb" in its sysfs device path. */
function linuxIsUsb(devName, sysBlock = '/sys/block') {
  const m = /^\/dev\/(sd[a-z]+|nvme\d+n?\d*)$/.exec(devName || '');
  if (!m) return false;
  try {
    return fs.realpathSync(path.join(sysBlock, m[1].replace(/^(nvme\d+)$/, '$1n1'))).includes('/usb');
  } catch {
    return false;
  }
}

const norm = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();

/**
 * Scans and reads every drive smartctl can see.
 * @param {object} [opts]
 * @param {object[]} [opts.inventory]  hardware.storage from the scan, used to spot USB drives by serial
 */
async function checkDrives({ inventory = [], run = runJson, locate = locateSmartctl, platform = process.platform } = {}) {
  const startedAt = Date.now();
  const tool = locate();
  if (!tool) {
    return { ok: false, error: 'smartctl-missing', message: 'The drive health tool (smartctl) was not found.', drives: [], verdict: evaluateDrives([]) };
  }

  const version = await run(tool.file, ['-j', '--version'], 10000);
  const toolInfo = {
    source: tool.source,
    version: version.json?.smartctl?.version?.join('.') || null,
    // Only the file name: the full path can contain the user's name.
    file: path.basename(path.dirname(tool.file)) + '/' + path.basename(tool.file),
  };

  const scan = await run(tool.file, ['-j', '--scan-open'], SCAN_TIMEOUT_MS);
  if (scan.error) return { ok: false, error: 'scan-failed', message: scan.error, tool: toolInfo, drives: [], verdict: evaluateDrives([]) };

  // De-duplicate: one drive can show up under several device names.
  const devices = [];
  const seen = new Set();
  for (const d of scan.json.devices || []) {
    if (!d.name || seen.has(d.name)) continue;
    seen.add(d.name);
    devices.push(d);
  }

  const usbSerials = new Set(inventory.filter((d) => d.removable && d.serial).map((d) => norm(d.serial)));
  const drives = [];
  const serials = new Set();
  // One at a time: drives on the same controller don't like parallel queries.
  for (const dev of devices) {
    const args = ['-j', '-x'];
    if (dev.type) args.push('-d', dev.type);
    args.push(dev.name);
    const res = await run(tool.file, args, DRIVE_TIMEOUT_MS);
    if (res.error) {
      drives.push({ name: dev.name, type: dev.type || null, status: 'unknown', reason: res.error, checks: [], external: false, messages: [] });
      continue;
    }
    const json = res.json;
    const external = usbSerials.has(norm(json.serial_number)) || (platform === 'linux' && linuxIsUsb(dev.name));
    const drive = parseDrive(json, dev, { external });
    // Some drives (Apple NVMe) don't report their size: take it from the inventory.
    const inv = drive.serial && inventory.find((d) => d.serial && norm(d.serial) === norm(drive.serial));
    if (drive.capacityBytes === null && inv?.sizeBytes) {
      drive.capacityBytes = inv.sizeBytes;
      drive.capacity = inv.capacity || null;
    }
    if (!drive.needsAdmin && dev.open_error && permissionDenied({ smartctl: { messages: [{ string: dev.open_error }] } })) drive.needsAdmin = true;
    // Same physical drive reached two ways (e.g. /dev/sda and /dev/sg0).
    if (drive.serial && serials.has(norm(drive.serial))) continue;
    if (drive.serial) serials.add(norm(drive.serial));
    drives.push(drive);
  }

  for (const d of drives) d.line = driveLine(d);
  const internalInInventory = inventory.length ? inventory.filter((d) => !d.removable).length : null;
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    tool: toolInfo,
    needsAdmin: drives.some((d) => d.needsAdmin),
    drives,
    verdict: evaluateDrives(drives, { internalInInventory }),
  };
}

module.exports = { checkDrives, locateSmartctl, candidates, vendorTarget, linuxIsUsb };
