'use strict';

// Samples CPU temperature and clock on its own thread during a stress run.
//
// Reading temperature makes the firmware evaluate its ACPI thermal zones
// (Linux: a blocking read of /sys/class/thermal/*/temp; Windows: the WMI
// MSAcpi_ThermalZoneTemperature query). Some HP firmware answers these very
// slowly. On the main process that froze the app mid-test; here it can only
// make the temperature reading late. Samples never overlap, and a sensor that
// is too slow is switched off for the rest of the run.

const { parentPort } = require('node:worker_threads');
const si = require('systeminformation');

const INTERVAL_MS = 2000;
const SLOW_SENSOR_MS = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let readTemperature = true;
  for (;;) {
    const started = Date.now();
    let tempC = null;
    if (readTemperature) {
      const t0 = Date.now();
      const temp = await si.cpuTemperature().catch(() => ({}));
      tempC = temp.main > 0 ? temp.main : null;
      if (Date.now() - t0 > SLOW_SENSOR_MS) {
        readTemperature = false;
        parentPort.postMessage({ type: 'note', note: 'CPU temperature sensor responds too slowly; temperature is not sampled on this unit.' });
      }
    }
    const speed = await si.cpuCurrentSpeed().catch(() => ({}));
    parentPort.postMessage({ type: 'sample', tempC, ghz: speed.avg > 0 ? speed.avg : null });
    await sleep(Math.max(0, INTERVAL_MS - (Date.now() - started)));
  }
})();
