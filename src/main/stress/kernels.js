'use strict';

// Deterministic CPU kernels with known answers.
//
// Faulty CPUs, VRMs and overheating rarely crash outright first; they produce
// silently wrong results. Every kernel here returns a value that must match a
// golden answer exactly, so one flipped bit anywhere is caught.
//
// Only operations with exactly specified results are used: integer ops, and
// IEEE-754 + - * / sqrt (correctly rounded; JS never fuses into FMA). No
// Math.sin/exp etc, whose results may differ between platforms.

const crypto = require('node:crypto');

const SEEDS = [0x1234567, 0x2bd1e995, 0x5f3759df, 0x6a09e667, 0x3c6ef372, 0x7f4a7c15, 0x0badf00d, 0x41c64e6d];

function xorshift32(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
}

/** ALU: shifts, xors, 32-bit multiplies. */
function intKernel(seed, iters = 6_000_000) {
  let a = seed | 0;
  let b = 0x9e3779b9 | 0;
  let c = 0;
  let h = 0;
  for (let i = 0; i < iters; i++) {
    a ^= a << 13;
    a ^= a >>> 17;
    a ^= a << 5;
    b = Math.imul(b ^ a, 0x85ebca6b);
    c = (c + (b >>> 7) + i) | 0;
    h = (Math.imul(h ^ c, 0xc2b2ae35) + a) | 0;
  }
  return (h >>> 0).toString(16);
}

/** FPU: repeated 48×48 matrix multiply with renormalisation. */
function fpKernel(seed, n = 48, reps = 140) {
  const rnd = xorshift32(seed);
  let A = new Float64Array(n * n).map(() => rnd() / 2147483648 - 1);
  const B = new Float64Array(n * n).map(() => rnd() / 2147483648 - 1);
  let C = new Float64Array(n * n);
  for (let r = 0; r < reps; r++) {
    C.fill(0);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < n; k++) {
        const aik = A[i * n + k];
        for (let j = 0; j < n; j++) C[i * n + j] += aik * B[k * n + j];
      }
    }
    let norm = 0;
    for (let i = 0; i < C.length; i++) norm += C[i] * C[i];
    norm = Math.sqrt(norm);
    for (let i = 0; i < C.length; i++) C[i] /= norm;
    [A, C] = [C, A];
  }
  let sum = 0;
  for (let i = 0; i < A.length; i++) sum += A[i] * (i + 1);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, sum);
  return view.getBigUint64(0).toString(16); // exact bit pattern
}

/** Cache / memory controller: dependent random walk over a 16 MiB table. */
function memKernel(seed, words = 4 * 1024 * 1024, steps = 400_000) {
  const t = new Uint32Array(words);
  const rnd = xorshift32(seed);
  for (let i = 0; i < words; i++) t[i] = rnd();
  const mask = words - 1;
  let idx = seed & mask;
  let acc = 0;
  for (let s = 0; s < steps; s++) {
    const v = t[idx];
    t[idx] = (v + s) >>> 0;
    acc = (Math.imul(acc, 31) + v) | 0;
    idx = (v ^ s) & mask;
  }
  return (acc >>> 0).toString(16);
}

/** Native SIMD/crypto units (OpenSSL SHA-256, uses SHA-NI/AVX/NEON). */
function hashKernel(seed, bytes = 8 * 1024 * 1024, rounds = 3) {
  const buf = Buffer.allocUnsafe(bytes);
  const rnd = xorshift32(seed);
  for (let i = 0; i < bytes; i += 4) buf.writeUInt32LE(rnd(), i);
  let digest = Buffer.alloc(32);
  for (let r = 0; r < rounds; r++) {
    digest = crypto.createHash('sha256').update(digest).update(buf).digest();
  }
  return digest.toString('hex');
}

const KERNELS = { int: intKernel, fp: fpKernel, mem: memKernel, hash: hashKernel };

// Golden answers for KERNELS[name](SEEDS[i]). Generated once and frozen; the
// unit test recomputes them, so any change to a kernel must update these.
const GOLDEN = require('./golden.json');

module.exports = { KERNELS, SEEDS, GOLDEN, xorshift32 };
