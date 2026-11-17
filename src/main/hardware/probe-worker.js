'use strict';

// Runs systeminformation probes off the main thread.
//
// systeminformation runs many of its OS commands synchronously (execSync:
// nmcli/iw/netsh/ipconfig, dmidecode, cat ...). On the main process a single
// slow command froze the whole app and made every probe "time out" together;
// some HP firmware/images hit this on both Windows and Linux. On its own
// thread a slow command can only delay, and time out, its own probe.
//
// Two modes:
//   { name }                one probe (macOS/Linux: a pool of these)
//   { names, persistent }   a batch, one after another, posting each result as
//                           it lands. On Windows `persistent` sends every query
//                           through ONE PowerShell process: systeminformation
//                           otherwise starts a new PowerShell per query, and on
//                           some HP images each start takes ~9 s.
//
// Lives in an asarUnpack'd folder (package.json) because worker threads must
// load real files from disk in a packaged app.

const { parentPort, workerData } = require('node:worker_threads');
const si = require('systeminformation');

const PROBES = {
  system: () => si.system(),
  chassis: () => si.chassis(),
  baseboard: () => si.baseboard(),
  bios: () => si.bios(),
  osInfo: () => si.osInfo(),
  cpu: () => si.cpu(),
  mem: () => si.mem(),
  memLayout: () => si.memLayout(),
  graphics: () => si.graphics(),
  disks: () => si.diskLayout(),
  battery: () => si.battery(),
  network: () => si.networkInterfaces(),
  usb: () => si.usb(),
};

async function runOne(name) {
  const fn = PROBES[name];
  if (!fn) throw new Error(`unknown probe "${name}"`);
  return fn();
}

async function single() {
  try {
    parentPort.postMessage({ ok: true, value: await runOne(workerData?.name) });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err?.message || String(err) });
  }
}

async function batch() {
  const persistent = Boolean(workerData.persistent) && typeof si.powerShellStart === 'function';
  if (persistent) si.powerShellStart();
  try {
    for (const name of workerData.names) {
      parentPort.postMessage({ type: 'start', name });
      try {
        parentPort.postMessage({ type: 'result', name, ok: true, value: await runOne(name) });
      } catch (err) {
        parentPort.postMessage({ type: 'result', name, ok: false, error: err?.message || String(err) });
      }
    }
  } finally {
    if (persistent) si.powerShellRelease();
    parentPort.postMessage({ type: 'done' });
  }
}

(Array.isArray(workerData?.names) ? batch : single)();
