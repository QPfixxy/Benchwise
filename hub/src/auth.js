'use strict';

const { newKey, hashKey, bearer } = require('./keys');
const { verifyPassword, dummyVerify } = require('./passwords');

const SESSION_COOKIE = 'bwh_session';

/** Fixed-window limiter per key (IP, username...). In memory: per instance. */
function rateLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map();
  return {
    hit(key) {
      const t = now();
      const e = hits.get(key);
      if (!e || t - e.start >= windowMs) {
        hits.set(key, { start: t, count: 1 });
        if (hits.size > 10000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
        return true;
      }
      e.count += 1;
      return e.count <= max;
    },
    /** True once `key` has used up its allowance in the current window (doesn't count as a hit). */
    blocked(key) {
      const e = hits.get(key);
      return Boolean(e) && now() - e.start < windowMs && e.count >= max;
    },
    reset: (key) => hits.delete(key),
  };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** A station, by its key. Revoked keys are rejected. */
async function stationFromKey(pool, header) {
  const key = bearer(header, 'station');
  if (!key) return null;
  const r = await pool.query(
    `SELECT st.id, st.site_id, st.name, s.code AS site_code, s.name AS site_name
     FROM stations st JOIN sites s ON s.id = st.site_id WHERE st.key_hash = $1 AND st.revoked_at IS NULL`,
    [hashKey(key)],
  );
  return r.rows[0] || null;
}

/** An integration client (WMS, Tableau), by its key. */
async function clientFromKey(pool, header) {
  const key = bearer(header, 'client');
  if (!key) return null;
  const r = await pool.query('SELECT id, name, scopes, site_ids FROM api_clients WHERE key_hash = $1 AND revoked_at IS NULL', [hashKey(key)]);
  if (!r.rows.length) return null;
  const c = r.rows[0];
  pool.query('UPDATE api_clients SET last_used_at = now() WHERE id = $1', [c.id]).catch(() => {});
  return { kind: 'client', id: c.id, name: c.name, scopes: c.scopes, siteIds: c.site_ids || null, role: 'viewer' };
}

/** A signed-in staff member, by session cookie. Sliding expiry within the session's lifetime. */
async function userFromSession(pool, cookieHeader) {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!token || !token.startsWith('bwx_') || token.length > 80) return null;
  const r = await pool.query(
    `SELECT u.id, u.username, u.role, u.all_sites, s.id_hash,
            ARRAY(SELECT site_id FROM user_sites WHERE user_id = u.id) AS site_ids
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [hashKey(token)],
  );
  if (!r.rows.length) return null;
  const u = r.rows[0];
  pool.query('UPDATE sessions SET last_seen_at = now() WHERE id_hash = $1', [u.id_hash]).catch(() => {});
  return {
    kind: 'user',
    id: u.id,
    name: u.username,
    role: u.role,
    scopes: ['audits:read'],
    siteIds: u.all_sites ? null : u.site_ids,
  };
}

/** Signs in: returns a new session token, or null. Same timing whether or not the user exists. */
async function signIn(pool, username, password, { hours }) {
  const r = await pool.query('SELECT id, password_hash FROM users WHERE username = $1 AND disabled_at IS NULL', [String(username || '').toLowerCase()]);
  if (!r.rows.length) return dummyVerify(password).then(() => null);
  if (!(await verifyPassword(password, r.rows[0].password_hash))) return null;
  const { key, hash } = newKey('session');
  await pool.query(`INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`, [hash, r.rows[0].id, hours]);
  await pool.query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {});
  return key;
}

async function signOut(pool, cookieHeader) {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (token) await pool.query('DELETE FROM sessions WHERE id_hash = $1', [hashKey(token)]);
}

function sessionCookie(token, { hours, secure = true }) {
  return [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${hours * 3600}`, secure ? 'Secure' : null].filter(Boolean).join('; ');
}
const clearCookie = (secure = true) => [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0', secure ? 'Secure' : null].filter(Boolean).join('; ');

module.exports = { rateLimiter, parseCookies, stationFromKey, clientFromKey, userFromSession, signIn, signOut, sessionCookie, clearCookie, SESSION_COOKIE };
