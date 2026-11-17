'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const n = require('./normalize');

const PROBE_TIMEOUT_MS = 25000;
// Windows: systeminformation starts a fresh PowerShell for nearly every query.
// Dozens at once can take minutes on images with heavy endpoint/vendor
// software, so only a few probes run at a time there.
const CONCURRENCY = process.platform === 'win32' ? 3 : 6;
const PROBE_WORKER = path.join(__dirname, 'probe-worker.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

// Most important first: with limited concurrency these finish earliest.
const PROBES = [
  ['system', {}],
  ['bios', {}],
  ['baseboard', {}],
  ['chassis', {}],
  ['cpu', {}],
  ['mem', {}],
  ['memLayout', []],
  ['osInfo', {}],
  ['disks', []],
  ['battery', {}],
  ['graphics', {}],
  ['usb', []],
];

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Runs one systeminformation probe on its own thread (see probe-worker.js). */
function probeInWorker(name, ms) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(PROBE_WORKER, { workerData: { name } });
    const done = (fn, value) => {
      clearTimeout(timer);
      worker.removeAllListeners();
      worker.on('error', () => {}); // late errors after we've moved on
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(() => done(reject, new Error(`timed out after ${ms / 1000}s`)), ms);
    worker.once('message', (m) => (m?.ok ? done(resolve, m.value) : done(reject, new Error(m?.error || 'failed'))));
    worker.once('error', (err) => done(reject, err));
    worker.once('exit', (code) => done(reject, new Error(`probe stopped unexpectedly (exit ${code})`)));
  });
}

/**
 * Runs probes through a small pool. A failing or slow probe records a warning
 * and yields its fallback value instead of failing the whole report; timings
 * are kept so slow machines can be diagnosed from the saved report.
 */
async function runProbes(list, { run = probeInWorker, concurrency = CONCURRENCY, timeoutMs = PROBE_TIMEOUT_MS, now = Date.now } = {}) {
  const raw = {};
  const warnings = [];
  const timings = {};
  let next = 0;
  async function lane() {
    while (next < list.length) {
      const [key, fallback] = list[next++];
      const t0 = now();
      try {
        raw[key] = await run(key, timeoutMs);
        timings[key] = { ms: now() - t0, ok: true };
      } catch (err) {
        raw[key] = fallback;
        warnings.push(`${key}: ${err.message}`);
        timings[key] = { ms: now() - t0, ok: false, error: err.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, lane));
  return { raw, warnings, timings };
}

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    // execFile, not exec: no shell, so nothing here is ever interpreted.
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

/** OS-native serial lookup for when systeminformation returns a placeholder. */
async function fallbackSerial() {
  switch (process.platform) {
    case 'win32': {
      const out = await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-CimInstance -ClassName Win32_BIOS).SerialNumber',
      ]);
      return out.trim();
    }
    case 'darwin': {
      const out = await run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
      return (out.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/) || [])[1] || '';
    }
    case 'linux': {
      // Readable without sudo on some distros; always readable as root.
      for (const f of ['product_serial', 'chassis_serial', 'board_serial']) {
        try {
          return (await fs.readFile(`/sys/class/dmi/id/${f}`, 'utf8')).trim();
        } catch {
          /* try next */
        }
      }
      return '';
    }
    default:
      return '';
  }
}

/**
 * Linux: physical NICs straight from sysfs. Only interfaces backed by a real
 * device have a "device" link, which drops lo/docker/bridges/veth/tun. Unlike
 * systeminformation this also lists unplugged ports and runs no nmcli/iw.
 */
async function linuxNics(root = '/sys/class/net') {
  const read = (f) => fs.readFile(f, 'utf8').then((s) => s.trim(), () => '');
  const exists = (f) => fs.access(f).then(() => true, () => false);
  const out = [];
  for (const iface of await fs.readdir(root).catch(() => [])) {
    const base = path.join(root, iface);
    if (!(await exists(path.join(base, 'device')))) continue;
    const wireless = (await exists(path.join(base, 'wireless'))) || (await exists(path.join(base, 'phy80211')));
    const speed = Number(await read(path.join(base, 'speed'))); // errors / -1 while link is down
    out.push({ iface, ifaceName: iface, mac: await read(path.join(base, 'address')), type: wireless ? 'wireless' : 'wired', speed: speed > 0 ? speed : null });
  }
  return out;
}

/** Windows: one PowerShell call for physical adapters (incl. disconnected ones). */
async function windowsNics() {
  const out = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-NetAdapter -Physical | ForEach-Object { "$($_.Name)|$($_.InterfaceDescription)|$($_.MacAddress)|$($_.PhysicalMediaType)|$($_.ReceiveLinkSpeed)" }',
    ],
    15000,
  );
  return n.parseWindowsNetAdapters(out);
}

/**
 * Network adapters. macOS hides real MACs from ifconfig (02:00:00:00:00:00);
 * networksetup still reports burned-in addresses with friendly port names.
 * Windows/Linux read adapters directly; systeminformation's heavy probe is
 * only the fallback there.
 */
async function collectNetwork(getSiInterfaces) {
  if (process.platform === 'darwin') {
    const [ports, siInterfaces] = await Promise.all([
      run('networksetup', ['-listallhardwareports']).then(n.parseMacHardwarePorts),
      getSiInterfaces(),
    ]);
    if (ports.length) {
      const speeds = new Map((siInterfaces || []).map((i) => [i.iface, i.speed]));
      return n.normalizeNetwork(
        ports.map((p) => ({ ...p, speed: speeds.get(p.iface) })),
        { hardwareOnly: true },
      );
    }
    return n.normalizeNetwork(siInterfaces);
  }
  const native = process.platform === 'win32' ? await windowsNics() : process.platform === 'linux' ? await linuxNics() : [];
  if (native.length) return n.normalizeNetwork(native);
  return n.normalizeNetwork(await getSiInterfaces());
}

/** true = lid closed, false = open, null = unknown / not a laptop. */
async function lidClosed() {
  if (process.platform === 'darwin') {
    const out = await run('ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '1']);
    const m = out.match(/"AppleClamshellState"\s*=\s*(Yes|No)/);
    return m ? m[1] === 'Yes' : null;
  }
  if (process.platform === 'linux') {
    try {
      const [dir] = await fs.readdir('/proc/acpi/button/lid');
      return /closed/.test(await fs.readFile(`/proc/acpi/button/lid/${dir}/state`, 'utf8'));
    } catch {
      return null;
    }
  }
  return null; // Windows exposes lid state only via power-event subscriptions
}

async function collectHardware() {
  const started = Date.now();
  // Network runs alongside the pool (it's a direct OS read on Windows/Linux).
  const netWarnings = [];
  const netStarted = Date.now();
  const siNetwork = () =>
    probeInWorker('network', PROBE_TIMEOUT_MS).catch((err) => {
      netWarnings.push(`network: ${err.message}`);
      return [];
    });
  const [{ raw, warnings, timings }, network] = await Promise.all([
    runProbes(PROBES),
    withTimeout(collectNetwork(siNetwork), PROBE_TIMEOUT_MS + 5000, 'network').catch((err) => {
      netWarnings.push(err.message);
      return [];
    }),
  ]);
  warnings.push(...netWarnings);
  timings.network = { ms: Date.now() - netStarted, ok: netWarnings.length === 0 };

  const system = n.normalizeSystem(raw);
  if (!system.serial) {
    const serial = n.realValue(await fallbackSerial());
    if (serial) {
      system.serial = serial;
      system.serialSource = 'os';
    } else {
      warnings.push('System serial number could not be read from firmware.');
    }
  }

  // Linux: the chassis type number is world-readable in sysfs even when
  // dmidecode (root) isn't available or timed out.
  if (!system.chassisType && process.platform === 'linux') {
    system.chassisType = n.chassisName(await fs.readFile('/sys/class/dmi/id/chassis_type', 'utf8').catch(() => ''));
  }
  const battery = n.normalizeBattery(raw.battery);
  const form = n.classifyFormFactor({
    chassisType: system.chassisType,
    model: `${system.model || ''} ${system.version || ''}`,
    batteryPresent: battery.present,
  });
  system.formFactor = form.formFactor;
  system.formFactorSource = form.source;
  // Manual override for units with misleading firmware (and for testing).
  const forced = process.env.BENCHWISE_FORM_FACTOR;
  if (['laptop', 'tablet', 'all-in-one', 'desktop', 'server'].includes(forced)) {
    system.formFactor = forced;
    system.formFactorSource = 'override';
  }

  const memory = n.normalizeMemory(raw.mem, raw.memLayout);
  const disks = n.normalizeDisks(raw.disks);

  const isLinuxNonRoot = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() !== 0;
  if (isLinuxNonRoot && (!system.serial || memory.slots.length === 0)) {
    warnings.push('Some firmware details (serials, memory modules) need administrator access on Linux. Restart Benchwise and choose "Continue as administrator" (or run it with sudo).');
  }
  if (disks.some((d) => d.smartStatus === 'Unknown')) {
    warnings.push('SMART status unavailable in the inventory for one or more drives. The Drive Health test reads it directly.');
  }

  return {
    collectedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    system,
    cpu: n.normalizeCpu(raw.cpu),
    memory,
    graphics: n.normalizeGraphics(raw.graphics),
    storage: disks,
    battery,
    network,
    usb: n.normalizeUsb(raw.usb),
    host: { hostname: os.hostname(), uptimeSeconds: Math.round(os.uptime()) },
    capabilities: { lidClosed: await lidClosed() },
    // How long each probe took. Saved with the report so a slow or
    // incomplete scan on an unusual model can be diagnosed afterwards.
    diagnostics: { probes: timings, concurrency: CONCURRENCY, timeoutMs: PROBE_TIMEOUT_MS },
    warnings,
  };
}

module.exports = { collectHardware, runProbes, linuxNics };
