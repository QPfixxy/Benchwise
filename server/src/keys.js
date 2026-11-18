'use strict';

// Station keys (bws_...) and integration keys (bwa_...): 256 random bits,
// shown once, stored only as a SHA-256 hash. The first characters are kept
// as a prefix so a key can be recognised in lists without storing it.

const crypto = require('node:crypto');

const KINDS = { station: 'bws', client: 'bwa', session: 'bwx' };

function newKey(kind) {
  const tag = KINDS[kind];
  if (!tag) throw new Error(`unknown key kind ${kind}`);
  const secret = crypto.randomBytes(32).toString('base64url');
  const key = `${tag}_${secret}`;
  return { key, prefix: key.slice(0, 12), hash: hashKey(key) };
}

/** Keys are high-entropy random values, so a plain SHA-256 is the right hash (no salt/stretching needed). */
const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest();

/** Extracts a key of the given kind from an "Authorization: Bearer ..." header. */
function bearer(header, kind) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(header || ''));
  if (!m) return null;
  return m[1].startsWith(`${KINDS[kind]}_`) && m[1].length >= 40 && m[1].length <= 80 ? m[1] : null;
}

module.exports = { newKey, hashKey, bearer };
