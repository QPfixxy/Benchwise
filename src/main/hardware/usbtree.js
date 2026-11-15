'use strict';

// Snapshot of the USB device tree with *physical location* and *negotiated
// link speed* per device: the two things a port test needs and that
// systeminformation's si.usb() doesn't provide. Parsers are pure (tested);
// providers shell out per OS without a shell.

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? '' : String(stdout)),
    );
  });
}

const JUNK = /^(not provided|none|0+|n\/a)?$/i;
const clean = (v) => (v === undefined || v === null ? null : String(v).trim() || null);
const serialOf = (v) => (clean(v) && !JUNK.test(String(v).trim()) ? String(v).trim() : null);

/** "480 Mb/s", "5 Gb/s", "high_speed", 480, "5000" -> Mb/s number */
function parseSpeedMbps(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim().toLowerCase();
  const named = { low_speed: 1.5, full_speed: 12, high_speed: 480, super_speed: 5000, super_speed_plus: 10000 };
  if (named[s] !== undefined) return named[s];
  const m = s.match(/([\d.]+)\s*(g|m)?b/);
  if (m) return parseFloat(m[1]) * (m[2] === 'g' ? 1000 : 1);
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function speedLabel(mbps) {
  if (!mbps) return null;
  if (mbps <= 1.5) return 'USB 1.0 Low Speed (1.5 Mb/s)';
  if (mbps <= 12) return 'USB 1.1 Full Speed (12 Mb/s)';
  if (mbps <= 480) return 'USB 2.0 High Speed (480 Mb/s)';
  if (mbps <= 5000) return 'USB 3 SuperSpeed (5 Gb/s)';
  if (mbps <= 10000) return 'USB 3 SuperSpeed+ (10 Gb/s)';
  return `USB ${mbps >= 40000 ? '4 / Thunderbolt' : '3.2 2×2'} (${mbps / 1000} Gb/s)`;
}

function device({ location, name, vendorId, productId, serial, speedMbps, hub }) {
  return {
    key: `${location || '?'}|${vendorId || ''}:${productId || ''}|${serial || ''}`,
    location: clean(location),
    name: clean(name) || 'USB device',
    vendorId: clean(vendorId)?.toLowerCase().replace(/^0x/, '') || null,
    productId: clean(productId)?.toLowerCase().replace(/^0x/, '') || null,
    serial: serial || null,
    speedMbps: speedMbps ?? null,
    speed: speedLabel(speedMbps),
    hub: Boolean(hub),
  };
}

// ------------------------------------------------------------------ macOS

/** Parses `system_profiler SPUSBHostDataType -json` (macOS 15+) or the older SPUSBDataType. */
function parseMacUsb(json) {
  let data;
  try {
    data = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return [];
  }
  const roots = data?.SPUSBHostDataType || data?.SPUSBDataType || [];
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    const loc = node.USBKeyLocationID || node.location_id;
    if (loc && node._name) {
      out.push(
        device({
          location: String(loc).split(' ')[0], // old format: "0x14100000 / 3"
          name: node._name,
          vendorId: node.USBDeviceKeyVendorID || String(node.vendor_id || '').split(' ')[0],
          productId: node.USBDeviceKeyProductID || node.product_id,
          serial: serialOf(node.USBDeviceKeySerialNumber || node.serial_num),
          speedMbps: parseSpeedMbps(node.USBDeviceKeyLinkSpeed || node.device_speed),
          hub: /hub|\bbus\b/i.test(node._name), // "USB 3.1 Bus" = root controller
        }),
      );
    }
    (node._items || []).forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

async function macSnapshot() {
  let list = parseMacUsb(await run('system_profiler', ['SPUSBHostDataType', '-json']));
  if (!list.length) list = parseMacUsb(await run('system_profiler', ['SPUSBDataType', '-json']));
  return list;
}

// ------------------------------------------------------------------ Linux

/** sysfs device dir names that are real devices ("1-2", "3-1.4"), not roots or interfaces. */
const LINUX_PORT = /^\d+-[\d.]+$/;

function parseLinuxUsbEntry(name, attrs) {
  return device({
    location: name, // bus-port.port path IS the physical port identity
    name: [attrs.manufacturer, attrs.product].filter(Boolean).join(' ') || attrs.product,
    vendorId: attrs.idVendor,
    productId: attrs.idProduct,
    serial: serialOf(attrs.serial),
    speedMbps: parseSpeedMbps(attrs.speed),
    hub: attrs.bDeviceClass === '09',
  });
}

async function linuxSnapshot(root = '/sys/bus/usb/devices') {
  let names;
  try {
    names = (await fs.readdir(root)).filter((n) => LINUX_PORT.test(n));
  } catch {
    return [];
  }
  const read = (dir, f) => fs.readFile(path.join(dir, f), 'utf8').then((s) => s.trim(), () => null);
  return Promise.all(
    names.map(async (n) => {
      const dir = path.join(root, n);
      const keys = ['manufacturer', 'product', 'idVendor', 'idProduct', 'serial', 'speed', 'bDeviceClass'];
      const vals = await Promise.all(keys.map((k) => read(dir, k)));
      return parseLinuxUsbEntry(n, Object.fromEntries(keys.map((k, i) => [k, vals[i]])));
    }),
  );
}

// ------------------------------------------------------------------ Windows

const WIN_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like 'USB\\VID_*' -and $_.InstanceId -notlike '*&MI_*' } | ForEach-Object {
  [pscustomobject]@{
    id = $_.InstanceId
    name = $_.FriendlyName
    cls = $_.Class
    loc = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName 'DEVPKEY_Device_LocationInfo').Data
    parent = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName 'DEVPKEY_Device_Parent').Data
  }
} | ConvertTo-Json -Compress`;

/** Parses the PowerShell output above. Windows doesn't expose link speed simply; throughput covers it. */
function parseWindowsUsb(json) {
  let rows;
  try {
    rows = JSON.parse(json || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) rows = [rows];
  return rows
    .filter((r) => r && r.id)
    .map((r) => {
      const m = String(r.id).match(/VID_([0-9A-F]{4})&PID_([0-9A-F]{4})\\(.+)$/i);
      const tail = m?.[3] || '';
      // Windows invents an ID containing '&' when a device has no serial.
      const serial = tail && !tail.includes('&') ? tail : null;
      // LocationInfo is "Port_#0002.Hub_#0003": unique per physical port on a hub.
      const location = r.loc ? `${r.loc}${r.parent ? ` @ ${String(r.parent).split('\\').slice(-1)[0]}` : ''}` : null;
      return device({
        location,
        name: r.name,
        vendorId: m?.[1],
        productId: m?.[2],
        serial,
        speedMbps: null,
        hub: /hub/i.test(r.name || '') || r.cls === 'USBHub',
      });
    });
}

async function windowsSnapshot() {
  return parseWindowsUsb(
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_SCRIPT], 30000),
  );
}

// ------------------------------------------------------------------ API

async function snapshotUsb() {
  try {
    if (process.platform === 'darwin') return await macSnapshot();
    if (process.platform === 'linux') return await linuxSnapshot();
    if (process.platform === 'win32') return await windowsSnapshot();
  } catch {
    /* fall through */
  }
  return [];
}

/**
 * Which device in `after` is the test drive? Prefer a remembered identity
 * (serial or vendor:product); otherwise the single new non-hub device.
 */
function identifyStick(before, after, remembered) {
  const leaves = after.filter((d) => !d.hub);
  if (remembered) {
    const match =
      (remembered.serial && leaves.find((d) => d.serial === remembered.serial)) ||
      leaves.find((d) => d.vendorId === remembered.vendorId && d.productId === remembered.productId && !before.some((b) => b.key === d.key));
    if (match) return match;
  }
  const beforeKeys = new Set(before.map((d) => d.key));
  const added = leaves.filter((d) => !beforeKeys.has(d.key));
  if (added.length === 1) return added[0];
  return added.find((d) => /stor|flash|disk|drive|usb\s*3|cruzer|sandisk|kingston|samsung|lexar|pny|transcend/i.test(d.name)) || null;
}

module.exports = { snapshotUsb, parseMacUsb, parseLinuxUsbEntry, parseWindowsUsb, parseSpeedMbps, speedLabel, identifyStick, LINUX_PORT };
