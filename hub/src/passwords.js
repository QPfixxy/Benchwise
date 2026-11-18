'use strict';

// Staff passwords: scrypt (memory-hard), per-password salt, parameters stored
// with the hash so they can be raised later without breaking old hashes.

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;
const MIN_LENGTH = 12;

function checkStrength(password) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters.`;
  if (password.length > 256) return 'Use at most 256 characters.';
  return null;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(password, salt, KEYLEN, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const dk = await scrypt(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: PARAMS.maxmem,
  });
  return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
}

// A fixed hash to verify against when the user doesn't exist, so a failed
// sign-in takes the same time either way (no user enumeration by timing).
let dummy = null;
async function dummyVerify(password) {
  dummy ??= await hashPassword('benchwise-dummy-password');
  await verifyPassword(password, dummy);
  return false;
}

module.exports = { hashPassword, verifyPassword, dummyVerify, checkStrength, MIN_LENGTH };
