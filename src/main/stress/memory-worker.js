'use strict';

// Allocates this worker's share of RAM as ArrayBuffer chunks, then runs
// write-all / verify-all passes for every pattern.

const { parentPort, workerData } = require('node:worker_threads');
const { PATTERNS, writePattern, verifyPattern } = require('./memory-patterns');

const { id, bytes, passes, stopFlag, injectFault } = workerData;
const stop = new Int32Array(stopFlag);
const stopped = () => Atomics.load(stop, 0) !== 0;
const CHUNK_BYTES = 256 * 1024 * 1024;
const MAX_SAMPLES = 10;
const hex = (v) => `0x${(v >>> 0).toString(16).padStart(8, '0')}`;

const chunks = [];
let allocated = 0;
let allocError = null;
while (allocated < bytes && !stopped()) {
  const size = Math.min(CHUNK_BYTES, bytes - allocated) & ~3;
  if (size <= 0) break;
  try {
    chunks.push(new Uint32Array(new ArrayBuffer(size)));
    allocated += size;
  } catch (err) {
    allocError = err.message; // OS refused: test what we got
    break;
  }
}

let processed = 0; // bytes written + bytes verified
let errorCount = 0;
const errors = [];
let pass = 0;
let pattern = null;
const totalWork = allocated * 2 * PATTERNS.length * passes;

const post = (type = 'progress') =>
  parentPort.postMessage({ type, id, allocated, allocError, processed, totalWork, errorCount, errors, pass, pattern });

post();
outer: for (pass = 1; pass <= passes; pass++) {
  const salt = Math.imul(pass, 0x27d4eb2d) ^ id;
  for (pattern of PATTERNS) {
    for (let c = 0; c < chunks.length; c++) {
      if (stopped()) break outer;
      writePattern(chunks[c], pattern, c, salt);
      processed += chunks[c].byteLength;
      post();
    }
    if (injectFault && id === 0 && pass === 1 && pattern === 'address' && chunks.length) chunks[0][7] ^= 0x10; // test hook only
    for (let c = 0; c < chunks.length; c++) {
      if (stopped()) break outer;
      errorCount += verifyPattern(chunks[c], pattern, c, salt, (i, want, got) => {
        if (errors.length < MAX_SAMPLES) {
          errors.push({ worker: id, pass, pattern, chunk: c, offset: i * 4, expected: hex(want), got: hex(got), bits: hex(want ^ got) });
        }
      });
      processed += chunks[c].byteLength;
      post();
    }
  }
}
post('final');
