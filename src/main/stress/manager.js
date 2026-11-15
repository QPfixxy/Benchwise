'use strict';

// Main-process side of stress testing: sizes the run, starts the isolated
// host, samples temperature/clock, and turns the raw result into a verdict.
// One run at a time (running CPU and memory together would confound both).

const path = require('node:path');
const { PROFILES, evaluateCpu, evaluateMemory } = require('./verdict');

const HOST = path.join(__dirname, 'host.js');
const TELEMETRY_MS = 2000;
const MIN_MEMORY_BYTES = 64 * 1024 * 1024;

class StressManager {
  /**
   * @param {object} deps
   * @param {(file: string) => {postMessage, on, kill}} deps.fork   starts host.js in a child process
   * @param {() => Promise<{tempC, ghz}>} deps.sampleTelemetry
   * @param {() => Promise<{available: number, total: number}>} deps.memInfo
   * @param {(event) => void} deps.emit   sends events to the UI
   */
  constructor({ fork, sampleTelemetry, memInfo, emit }) {
    Object.assign(this, { fork, sampleTelemetry, memInfo, emit });
    this.run = null;
    this.last = {}; // kind -> last finished event
  }

  profiles() {
    return Object.fromEntries(
      Object.entries(PROFILES).map(([kind, ps]) => [kind, Object.entries(ps).map(([id, p]) => ({ id, label: p.label }))]),
    );
  }

  status() {
    return { running: this.run ? { kind: this.run.kind, profile: this.run.profile, startedAt: this.run.startedAt, progress: this.run.progress, plan: this.run.plan } : null, last: this.last };
  }

  async start(kind, profile, extra = {}) {
    if (this.run) throw new Error(`A ${this.run.kind === 'cpu' ? 'CPU' : 'memory'} stress test is already running.`);
    const p = PROFILES[kind]?.[profile];
    if (!p) throw new Error('Unknown stress test or profile.');

    let options;
    let plan;
    if (kind === 'cpu') {
      options = { durationMs: extra.durationMs || p.durationMs, threads: extra.threads, injectFault: extra.injectFault };
      plan = { durationMs: options.durationMs };
    } else {
      const mem = await this.memInfo();
      const bytes = extra.bytes || Math.max(MIN_MEMORY_BYTES, Math.floor((mem.available || 0) * p.fraction));
      options = { bytes, passes: p.passes, threads: extra.threads, injectFault: extra.injectFault };
      plan = { bytes, passes: p.passes, installedBytes: mem.total };
    }

    const child = this.fork(HOST);
    const run = { kind, profile, plan, child, startedAt: new Date().toISOString(), telemetry: [], progress: null };
    this.run = run;

    const sample = async () => {
      try {
        run.telemetry.push({ t: Date.now(), ...(await this.sampleTelemetry()) });
      } catch {
        /* telemetry is best-effort */
      }
    };
    sample();
    run.timer = setInterval(sample, TELEMETRY_MS);

    const finish = (result) => {
      if (this.run !== run) return;
      clearInterval(run.timer);
      this.run = null;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      const verdict =
        kind === 'cpu'
          ? evaluateCpu(result, { telemetry: run.telemetry, profile })
          : evaluateMemory(result, { targetBytes: plan.bytes, installedBytes: plan.installedBytes, profile });
      const event = { type: 'done', kind, profile, startedAt: run.startedAt, finishedAt: new Date().toISOString(), verdict };
      this.last[kind] = event;
      this.emit(event);
    };

    child.on('message', (msg) => {
      if (msg?.type === 'progress') {
        const latest = run.telemetry[run.telemetry.length - 1] || {};
        run.progress = { ...msg, tempC: latest.tempC ?? null, ghz: latest.ghz ?? null };
        this.emit({ type: 'progress', kind, profile, plan, progress: run.progress });
      } else if (msg?.type === 'done') {
        finish(msg.result);
      }
    });
    child.on('exit', (code) => {
      // Host died without reporting (e.g. killed by the OS for memory).
      finish({ kind, threads: 0, elapsedMs: Date.now() - Date.parse(run.startedAt), aborted: false, crashes: [`stress process exited unexpectedly (code ${code})`], errorCount: 0, errors: [], rounds: 0, allocated: 0, windows: [] });
    });

    child.postMessage({ type: 'start', kind, options });
    this.emit({ type: 'started', kind, profile, plan });
    return { kind, profile, plan };
  }

  stop() {
    if (this.run) this.run.child.postMessage({ type: 'stop' });
  }

  dispose() {
    if (this.run) {
      clearInterval(this.run.timer);
      try {
        this.run.child.kill();
      } catch {
        /* ignore */
      }
      this.run = null;
    }
  }
}

module.exports = { StressManager };
