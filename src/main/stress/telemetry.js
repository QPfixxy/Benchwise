'use strict';

// Main-process helpers for stress runs that must never block the app.

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const WORKER = path.join(__dirname, 'telemetry-worker.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const IDLE_STOP_MS = 10000;

/**
 * Keeps the latest CPU temperature/clock from a background worker
 * (telemetry-worker.js). latest() returns immediately; the worker starts on
 * first use and stops after a few seconds without being asked.
 */
class TelemetrySampler {
  constructor({ createWorker = () => new Worker(WORKER) } = {}) {
    this.createWorker = createWorker;
    this.worker = null;
    this.last = { tempC: null, ghz: null };
    this.notes = [];
    this.idleTimer = null;
  }

  latest() {
    if (!this.worker) this.#start();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_STOP_MS);
    this.idleTimer.unref?.();
    return { ...this.last };
  }

  #start() {
    try {
      this.worker = this.createWorker();
    } catch {
      return; // no telemetry; the stress test itself still runs
    }
    this.worker.on('message', (m) => {
      if (m?.type === 'sample') this.last = { tempC: m.tempC, ghz: m.ghz };
      else if (m?.type === 'note' && !this.notes.includes(m.note)) this.notes.push(m.note);
    });
    this.worker.on('error', () => this.stop());
    this.worker.on('exit', () => {
      this.worker = null;
    });
  }

  stop() {
    clearTimeout(this.idleTimer);
    const w = this.worker;
    this.worker = null;
    w?.terminate().catch(() => {});
  }
}

/**
 * Free/total memory for sizing the memory test, without systeminformation's
 * PowerShell round trip on Windows.
 */
async function memInfo(siMem) {
  if (process.platform === 'linux') {
    const text = await fs.readFile('/proc/meminfo', 'utf8');
    const kb = (key) => Number((text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm')) || [])[1] || 0) * 1024;
    return { available: kb('MemAvailable') || kb('MemFree'), total: kb('MemTotal') };
  }
  if (process.platform === 'win32') return { available: os.freemem(), total: os.totalmem() };
  return siMem(); // macOS: os.freemem() ignores reclaimable cache; si uses vm_stat
}

module.exports = { TelemetrySampler, memInfo };
