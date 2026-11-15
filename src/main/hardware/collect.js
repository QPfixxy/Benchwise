'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const { execFile } = require('node:child_process');
const si = require('systeminformation');
const n = require('./normalize');

const PROBE_TIMEOUT_MS = 20000;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Runs every probe in parallel. A failing probe records a warning and yields
 * its fallback value instead of failing the whole report.
 */
async function runProbes(probes) {
  const warnings = [];
  const entries = await Promise.all(
    Object.entries(probes).map(async ([key, [fn, fallback]]) => {
      try {
        return [key, await withTimeout(Promise.resolve().then(fn), PROBE_TIMEOUT_MS, key)];
      } catch (err) {
        warnings.push(`${key}: ${err.message}`);
        return [key, fallback];
      }
    }),
  );
  return { raw: Object.fromEntries(entries), warnings };
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
 * macOS hides real MACs from ifconfig (02:00:00:00:00:00); networksetup still
 * reports burned-in addresses with friendly port names.
 */
async function collectNetwork(siInterfaces) {
  if (process.platform === 'darwin') {
    const ports = n.parseMacHardwarePorts(await run('networksetup', ['-listallhardwareports']));
    if (ports.length) {
      const speeds = new Map((siInterfaces || []).map((i) => [i.iface, i.speed]));
      return n.normalizeNetwork(
        ports.map((p) => ({ ...p, speed: speeds.get(p.iface) })),
        { hardwareOnly: true },
      );
    }
  }
  return n.normalizeNetwork(siInterfaces);
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
  const { raw, warnings } = await runProbes({
    system: [() => si.system(), {}],
    chassis: [() => si.chassis(), {}],
    baseboard: [() => si.baseboard(), {}],
    bios: [() => si.bios(), {}],
    osInfo: [() => si.osInfo(), {}],
    cpu: [() => si.cpu(), {}],
    mem: [() => si.mem(), {}],
    memLayout: [() => si.memLayout(), []],
    graphics: [() => si.graphics(), {}],
    disks: [() => si.diskLayout(), []],
    battery: [() => si.battery(), {}],
    network: [() => si.networkInterfaces(), []],
    usb: [() => si.usb(), []],
  });

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

  const memory = n.normalizeMemory(raw.mem, raw.memLayout);
  const disks = n.normalizeDisks(raw.disks);

  const isLinuxNonRoot = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() !== 0;
  if (isLinuxNonRoot && (!system.serial || memory.slots.length === 0)) {
    warnings.push('Some firmware details (serials, memory modules) need administrator access on Linux. Restart Benchwise and choose "Continue as administrator" (or run it with sudo).');
  }
  if (disks.some((d) => d.smartStatus === 'Unknown')) {
    warnings.push('SMART status unavailable for one or more drives (install smartmontools for drive health).');
  }

  return {
    collectedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    system,
    cpu: n.normalizeCpu(raw.cpu),
    memory,
    graphics: n.normalizeGraphics(raw.graphics),
    storage: disks,
    battery: n.normalizeBattery(raw.battery),
    network: await collectNetwork(raw.network),
    usb: n.normalizeUsb(raw.usb),
    host: { hostname: os.hostname(), uptimeSeconds: Math.round(os.uptime()) },
    capabilities: { lidClosed: await lidClosed() },
    warnings,
  };
}

module.exports = { collectHardware };
