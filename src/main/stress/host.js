'use strict';

// Stress-test host. Runs in an Electron utilityProcess (or a plain Node child
// process in tests) so a hang, crash or out-of-memory can never take down the
// UI. Spawns worker threads, aggregates their progress, reports to the parent.
//
// Parent -> host: { type: 'start', kind: 'cpu'|'memory', options } | { type: 'stop' }
// Host -> parent: { type: 'progress', ... } | { type: 'done', result }

const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');

const parentPort = process.parentPort; // set in Electron utilityProcess
const send = (msg) => (parentPort ? parentPort.postMessage(msg) : process.send(msg));
const onMessage = (fn) => (parentPort ? parentPort.on('message', (e) => fn(e.data)) : process.on('message', fn));

const stopBuf = new SharedArrayBuffer(4);
const stopFlag = new Int32Array(stopBuf);
let running = false;

onMessage((msg) => {
  if (msg?.type === 'start' && !running) {
    running = true;
    run(msg.kind, msg.options || {}).then(
      (result) => send({ type: 'done', result }),
      (err) => send({ type: 'done', result: { kind: msg.kind, fatal: err.message, aborted: false, crashes: [err.message] } }),
    );
  } else if (msg?.type === 'stop') {
    Atomics.store(stopFlag, 0, 1);
  }
});

function spawn(file, workerData, onMsg) {
  return new Promise((resolve) => {
    const w = new Worker(path.join(__dirname, file), { workerData });
    let crash = null;
    w.on('message', onMsg);
    w.on('error', (err) => (crash = `worker ${workerData.id}: ${err.message}`));
    w.on('exit', (code) => resolve(crash || (code !== 0 ? `worker ${workerData.id} exited with code ${code}` : null)));
  });
}

async function run(kind, options) {
  const threads = Math.max(1, options.threads || os.availableParallelism());
  const started = Date.now();
  const state = new Map(); // worker id -> latest message

  const aggregate = () => {
    const all = [...state.values()];
    const sum = (k) => all.reduce((a, m) => a + (m[k] || 0), 0);
    return {
      workers: all.length,
      errorCount: sum('errorCount'),
      errors: all.flatMap((m) => m.errors || []).slice(0, 10),
      rounds: sum('rounds'),
      allocated: sum('allocated'),
      processed: sum('processed'),
      totalWork: sum('totalWork'),
      allocErrors: all.map((m) => m.allocError).filter(Boolean),
    };
  };

  // Throughput in fixed windows (CPU) so throttling shows up as a decline.
  const WINDOW_MS = 5000;
  const windows = [];
  let lastRounds = 0;
  const windowTimer = setInterval(() => {
    const r = aggregate().rounds;
    windows.push(r - lastRounds);
    lastRounds = r;
  }, WINDOW_MS);
  const progressTimer = setInterval(() => send({ type: 'progress', kind, elapsedMs: Date.now() - started, threads, ...aggregate() }), 1000);

  let crashes;
  try {
    if (kind === 'cpu') {
      const deadline = started + options.durationMs;
      crashes = await Promise.all(
        Array.from({ length: threads }, (_, id) =>
          spawn('cpu-worker.js', { id, deadline, stopFlag: stopBuf, injectFault: Boolean(options.injectFault) }, (m) => state.set(m.id, m)),
        ),
      );
    } else if (kind === 'memory') {
      const per = Math.floor(options.bytes / threads / 4) * 4;
      crashes = await Promise.all(
        Array.from({ length: threads }, (_, id) =>
          spawn('memory-worker.js', { id, bytes: per, passes: options.passes, stopFlag: stopBuf, injectFault: Boolean(options.injectFault) }, (m) =>
            state.set(m.id, m),
          ),
        ),
      );
    } else {
      throw new Error(`unknown stress kind ${kind}`);
    }
  } finally {
    clearInterval(windowTimer);
    clearInterval(progressTimer);
  }

  const agg = aggregate();
  return {
    kind,
    threads,
    elapsedMs: Date.now() - started,
    aborted: Atomics.load(stopFlag, 0) !== 0,
    crashes: crashes.filter(Boolean),
    windows,
    windowMs: WINDOW_MS,
    ...agg,
  };
}
