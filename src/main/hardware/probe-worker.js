'use strict';

// Runs ONE systeminformation probe on its own thread.
//
// systeminformation runs many of its OS commands synchronously (execSync:
// nmcli/iw/netsh/ipconfig, dmidecode, cat ...). On the main process a single
// slow command froze the whole app and made every probe "time out" together;
// some HP firmware/images hit this on both Windows and Linux. On its own
// thread a slow command can only delay, and time out, its own probe.
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

(async () => {
  try {
    const fn = PROBES[workerData?.name];
    if (!fn) throw new Error(`unknown probe "${workerData?.name}"`);
    parentPort.postMessage({ ok: true, value: await fn() });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err?.message || String(err) });
  }
})();
