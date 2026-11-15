'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { KERNELS, SEEDS, GOLDEN } = require('../src/main/stress/kernels');
const { PATTERNS, writePattern, verifyPattern } = require('../src/main/stress/memory-patterns');
const { evaluateCpu, evaluateMemory, throttleDrop } = require('../src/main/stress/verdict');
const { StressManager } = require('../src/main/stress/manager');

test('every kernel reproduces its golden answers (determinism on this platform)', () => {
  for (const [name, fn] of Object.entries(KERNELS)) {
    // Two seeds per kernel keeps the suite fast; the stress run itself covers all.
    for (const i of [0, SEEDS.length - 1]) assert.equal(fn(SEEDS[i]), GOLDEN[name][i], `${name}[${i}]`);
  }
});

test('memory patterns verify cleanly and catch a single flipped bit', () => {
  for (const p of PATTERNS) {
    const a = new Uint32Array(4096);
    writePattern(a, p, 3, 0x1234);
    assert.equal(verifyPattern(a, p, 3, 0x1234), 0, p);
    a[1000] ^= 1 << 17;
    const hits = [];
    assert.equal(verifyPattern(a, p, 3, 0x1234, (i) => hits.push(i)), 1, p);
    assert.deepEqual(hits, [1000]);
  }
});

test('address and random patterns differ per chunk (catch address-line faults)', () => {
  for (const p of ['address', 'random']) {
    const a = new Uint32Array(64);
    const b = new Uint32Array(64);
    writePattern(a, p, 0, 7);
    writePattern(b, p, 1, 7);
    assert.notDeepEqual([...a], [...b], p);
    // Data written for chunk 0 must not verify as chunk 1 (i.e. wrong location).
    assert.ok(verifyPattern(a, p, 1, 7) > 0, p);
  }
});

test('throttle detection', () => {
  assert.equal(throttleDrop([5, 100, 100, 100, 100, 100, 100]), 0);
  assert.equal(throttleDrop([5, 100, 100, 100, 60, 60, 60]), 0.4);
  assert.equal(throttleDrop([5, 100, 100]), null); // too short to judge
});

test('CPU verdicts', () => {
  const base = { threads: 8, elapsedMs: 120000, rounds: 4000, errorCount: 0, errors: [], windows: [], crashes: [] };
  assert.equal(evaluateCpu(base, { profile: 'quick' }).status, 'pass');
  const bad = evaluateCpu({ ...base, errorCount: 2, errors: [{ worker: 3, round: 9, kernel: 'fp', expected: 'a', got: 'b' }] }, { profile: 'quick' });
  assert.equal(bad.status, 'fail');
  assert.match(bad.details.errorSamples[0], /thread 3 round 9: fp kernel/);
  // Errors win even if the operator stopped early.
  assert.equal(evaluateCpu({ ...base, aborted: true, errorCount: 1 }, {}).status, 'fail');
  assert.equal(evaluateCpu({ ...base, aborted: true }, {}).status, null);
  assert.equal(evaluateCpu({ ...base, crashes: ['worker 2 exited with code 1'] }, {}).status, 'fail');
  const hot = evaluateCpu({ ...base, windows: [1, 100, 100, 100, 50, 50, 50] }, { telemetry: [{ tempC: 99 }] });
  assert.equal(hot.status, 'pass'); // throttling/heat are warnings, not failures
  assert.equal(hot.warnings.length, 2);
});

test('memory verdicts', () => {
  const base = { threads: 4, elapsedMs: 60000, allocated: 8 * 1024 ** 3, errorCount: 0, errors: [], crashes: [] };
  assert.equal(evaluateMemory(base, { targetBytes: 8 * 1024 ** 3, profile: 'quick' }).status, 'pass');
  assert.equal(evaluateMemory({ ...base, errorCount: 3 }, {}).status, 'fail');
  assert.equal(evaluateMemory(base, { targetBytes: 32 * 1024 ** 3 }).warnings.length, 1); // allocation shortfall
});

// ------------------------------------------------------------- end to end

function nodeFork(file) {
  const cp = fork(file, [], { stdio: 'ignore' });
  return { postMessage: (m) => cp.send(m), on: (ev, fn) => cp.on(ev, fn), kill: () => cp.kill() };
}

function runStress(kind, extra) {
  return new Promise((resolve, reject) => {
    const events = [];
    const m = new StressManager({
      fork: nodeFork,
      sampleTelemetry: async () => ({ tempC: null, ghz: null }),
      memInfo: async () => ({ available: 1024 ** 3, total: 2 * 1024 ** 3 }),
      emit: (e) => {
        events.push(e);
        if (e.type === 'done') resolve({ done: e, events, manager: m });
      },
    });
    m.start(kind, 'quick', extra).catch(reject);
  });
}

test('end to end: CPU run on real worker threads passes', { timeout: 30000 }, async () => {
  const { done, events } = await runStress('cpu', { durationMs: 2500, threads: 2 });
  assert.equal(done.verdict.status, 'pass', done.verdict.summary);
  assert.ok(done.verdict.details.rounds >= 2);
  assert.ok(events.some((e) => e.type === 'progress'));
});

test('end to end: one wrong CPU answer fails the run', { timeout: 30000 }, async () => {
  const { done } = await runStress('cpu', { durationMs: 2000, threads: 2, injectFault: true });
  assert.equal(done.verdict.status, 'fail');
  assert.equal(done.verdict.details.computationErrors, 1);
});

test('end to end: memory run passes, and one flipped bit fails it', { timeout: 60000 }, async () => {
  const ok = await runStress('memory', { bytes: 32 * 1024 * 1024, threads: 2 });
  assert.equal(ok.done.verdict.status, 'pass', ok.done.verdict.summary);
  assert.equal(ok.done.verdict.details.tested, '0.0 GB'); // 32 MiB rounds to 0.0 GB in the summary
  const bad = await runStress('memory', { bytes: 32 * 1024 * 1024, threads: 2, injectFault: true });
  assert.equal(bad.done.verdict.status, 'fail');
  assert.equal(bad.done.verdict.details.errors, 1);
  assert.match(bad.done.verdict.details.errorSamples[0], /address pass 1: offset 28 .* \(bits 0x00000010\)/);
});

test('only one stress run at a time; stop gives no automatic verdict', { timeout: 30000 }, async () => {
  const result = await new Promise((resolve) => {
    const m = new StressManager({
      fork: nodeFork,
      sampleTelemetry: async () => ({}),
      memInfo: async () => ({ available: 1e9, total: 2e9 }),
      emit: (e) => e.type === 'done' && resolve(e),
    });
    m.start('cpu', 'quick', { durationMs: 60000, threads: 1 }).then(async () => {
      await assert.rejects(m.start('memory', 'quick'), /already running/);
      setTimeout(() => m.stop(), 800);
    });
  });
  assert.equal(result.verdict.status, null);
  assert.match(result.verdict.summary, /Stopped/);
});
