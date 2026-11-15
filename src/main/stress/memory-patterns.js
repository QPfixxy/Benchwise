'use strict';

// RAM test patterns over Uint32Array chunks. Each pattern is written to
// every chunk first and only then verified, so the data makes a round trip
// through DRAM rather than being served from cache.
//
// Pattern coverage (classic memtest set, user-space subset):
//   zeros / ones           stuck-at bits
//   checker / inv-checker  adjacent-bit coupling
//   walking-ones           each bit position in isolation
//   address                address-line faults (a word written to the wrong place)
//   random                 data-dependent / pattern-sensitive faults

const PATTERNS = ['zeros', 'ones', 'checker', 'inv-checker', 'walking-ones', 'address', 'random'];

const seedFor = (chunk, salt) => (Math.imul(chunk + 1, 0x9e3779b1) ^ salt ^ 0x5bd1e995) >>> 0 || 1;

/** Value generator for the pattern; stateful for 'random', so create one per pass over a chunk. */
function generator(pattern, chunk, salt) {
  switch (pattern) {
    case 'zeros':
      return () => 0;
    case 'ones':
      return () => 0xffffffff;
    case 'checker':
      return (i) => ((i & 1 ? 0x55555555 : 0xaaaaaaaa) >>> 0);
    case 'inv-checker':
      return (i) => ((i & 1 ? 0xaaaaaaaa : 0x55555555) >>> 0);
    case 'walking-ones':
      return (i) => (1 << ((i + chunk) & 31)) >>> 0;
    case 'address': {
      const k = seedFor(chunk, salt);
      return (i) => (i ^ k) >>> 0;
    }
    case 'random': {
      let s = seedFor(chunk, salt);
      return () => {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        return s >>> 0;
      };
    }
    default:
      throw new Error(`unknown pattern ${pattern}`);
  }
}

function writePattern(arr, pattern, chunk, salt) {
  const next = generator(pattern, chunk, salt);
  for (let i = 0; i < arr.length; i++) arr[i] = next(i);
}

/** Returns the number of mismatched words; calls onError(index, expected, got) for each. */
function verifyPattern(arr, pattern, chunk, salt, onError) {
  const next = generator(pattern, chunk, salt);
  let bad = 0;
  for (let i = 0; i < arr.length; i++) {
    const want = next(i);
    const got = arr[i];
    if (got !== want) {
      bad++;
      if (onError) onError(i, want, got);
    }
  }
  return bad;
}

module.exports = { PATTERNS, writePattern, verifyPattern };
