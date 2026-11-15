'use strict';

// One per logical core. Runs every kernel with rotating seeds until the
// deadline or the shared stop flag, checking each answer against GOLDEN.

const { parentPort, workerData } = require('node:worker_threads');
const { KERNELS, SEEDS, GOLDEN } = require('./kernels');

const { id, deadline, stopFlag, injectFault } = workerData;
const stop = new Int32Array(stopFlag);
const names = Object.keys(KERNELS);
const MAX_SAMPLES = 10;

let rounds = 0;
let errorCount = 0;
const errors = [];
let lastPost = 0;

const post = (final = false) => {
  parentPort.postMessage({ type: final ? 'final' : 'progress', id, rounds, errorCount, errors });
  lastPost = Date.now();
};

while (Date.now() < deadline && Atomics.load(stop, 0) === 0) {
  const s = rounds % SEEDS.length;
  for (const name of names) {
    let got = KERNELS[name](SEEDS[s]);
    if (injectFault && id === 0 && rounds === 1 && name === 'fp') got = '0'; // test hook only
    const expected = GOLDEN[name][s];
    if (got !== expected) {
      errorCount++;
      if (errors.length < MAX_SAMPLES) errors.push({ worker: id, round: rounds, kernel: name, seed: s, expected, got, at: Date.now() });
    }
  }
  rounds++;
  if (Date.now() - lastPost > 500) post();
}
post(true);
