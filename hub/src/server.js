'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Fastify = require('fastify');
const { loadConfig } = require('./config');
const { createPool, tx } = require('./db');
const { validateRecord, isPdf } = require('./records');
const store = require('./store');
const auth = require('./auth');
const { newKey } = require('./keys');
const { hashPassword, checkStrength } = require('./passwords');
const { version } = require('../package.json');

const PUBLIC = path.join(__dirname, '..', 'public');
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

function buildApp({ pool, config = loadConfig(), files = store.fileStore(config.filesDir), logger = true } = {}) {
  const https = config.tlsCert && config.tlsKey ? { cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey), minVersion: 'TLSv1.2' } : null;
  const app = Fastify({
    https,
    logger: logger && { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024, // 1 MB default; audit uploads get more
    // Strict: unknown fields are rejected with a 400, not silently dropped.
    ajv: { customOptions: { removeAdditional: false } },
  });

  // ------------------------------------------------------------ cross-cutting

  app.addHook('onSend', async (req, reply, payload) => {
    if (https) reply.header('Strict-Transport-Security', 'max-age=31536000'); // nginx sets it otherwise
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', CSP);
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err.validation) return reply.code(400).send({ error: `Invalid request: ${err.message}` });
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? 'Internal error' : err.message });
  });

  const authFailures = auth.rateLimiter({ max: 30, windowMs: 60_000 });
  const loginByIp = auth.rateLimiter({ max: 20, windowMs: 15 * 60_000 });
  const loginByUser = auth.rateLimiter({ max: 8, windowMs: 15 * 60_000 });

  /** Who is calling? Station key, integration key, or staff session. */
  async function principal(req, { station = false } = {}) {
    // Only failed attempts count; a client that keeps failing is paused.
    if (authFailures.blocked(req.ip)) fail(429, 'Too many failed attempts; try again shortly.');
    if (station) {
      const st = await auth.stationFromKey(pool, req.headers.authorization);
      if (st) return { kind: 'station', ...st };
    } else {
      const client = await auth.clientFromKey(pool, req.headers.authorization);
      if (client) return client;
      const user = await auth.userFromSession(pool, req.headers.cookie);
      if (user) {
        // Cookie-authenticated changes need our custom header (CSRF defence on top of SameSite=Strict).
        if (req.method !== 'GET' && req.headers['x-benchwise'] !== '1') fail(403, 'Missing X-Benchwise header.');
        return user;
      }
    }
    authFailures.hit(req.ip);
    fail(401, 'Not signed in or invalid key.');
  }
  const reader = async (req) => {
    const p = await principal(req);
    if (!p.scopes.includes('audits:read')) fail(403, 'This key cannot read audits.');
    return p;
  };
  const admin = async (req) => {
    const p = await principal(req);
    if (p.kind !== 'user' || p.role !== 'admin') fail(403, 'Administrators only.');
    return p;
  };

  // ------------------------------------------------------------ public

  app.get('/healthz', async () => {
    const r = await pool.query('SELECT count(*)::int AS n FROM schema_migrations');
    return { ok: true, version, migrations: r.rows[0].n };
  });

  for (const [route, [file, type]] of Object.entries(STATIC)) {
    const body = fs.readFileSync(path.join(PUBLIC, file));
    app.get(route, async (req, reply) => reply.type(type).header('Cache-Control', 'no-cache').send(body));
  }

  // ------------------------------------------------------------ stations

  app.get('/api/v1/station', async (req) => {
    const st = await principal(req, { station: true });
    return { station: st.name, site: { code: st.site_code, name: st.site_name } };
  });

  app.post(
    '/api/v1/audits',
    {
      bodyLimit: config.maxUploadMb * 1024 * 1024,
      schema: {
        body: {
          type: 'object',
          required: ['record'],
          additionalProperties: false,
          properties: { record: { type: 'object' }, pdf: { type: 'string', maxLength: config.maxUploadMb * 1024 * 1024 } },
        },
      },
    },
    async (req, reply) => {
      const st = await principal(req, { station: true });
      const { record, pdf } = req.body;
      const problem = validateRecord(record);
      if (problem) fail(400, `Invalid record: ${problem}`);
      let pdfSha = null;
      if (pdf) {
        const buf = Buffer.from(pdf, 'base64');
        if (!isPdf(buf)) fail(400, 'pdf is not a PDF file');
        pdfSha = await files.put(buf);
      }
      let res;
      try {
        res = await store.insertAudit(pool, { record, station: st, pdfSha });
      } catch (err) {
        if (err.code !== '23505') throw err; // two uploads of the same record at once
        res = { status: 'duplicate', id: record.id };
      }
      if (res.status === 'conflict') fail(409, 'A different record with this id already exists.');
      return reply.code(res.status === 'created' ? 201 : 200).send(res);
    },
  );

  // ------------------------------------------------------------ reading (integrations and staff)

  const searchSchema = {
    querystring: {
      type: 'object',
      additionalProperties: false,
      properties: {
        serial: { type: 'string', maxLength: 64 },
        site: { type: 'string', maxLength: 16 },
        overall: { type: 'string', enum: ['pass', 'fail', 'incomplete'] },
        profile: { type: 'string', enum: ['intake', 'full'] },
        q: { type: 'string', maxLength: 64 },
        since: { type: 'string', pattern: '^[0-9]{1,18}$' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
    },
  };

  app.get('/api/v1/audits', { schema: searchSchema }, async (req) => {
    const p = await reader(req);
    return store.searchAudits(pool, { ...req.query, siteIds: p.siteIds });
  });

  app.get('/api/v1/audits.csv', { schema: searchSchema }, async (req, reply) => {
    const p = await reader(req);
    const { items } = await store.searchAudits(pool, { ...req.query, limit: 500, siteIds: p.siteIds });
    const cols = ['completedAt', 'site', 'station', 'serial', 'assetTag', 'manufacturer', 'model', 'profile', 'overall', 'mdm', 'malware', 'technician', 'appVersion', 'id'];
    // Spreadsheet formula injection: a cell starting with = + - @ is prefixed with '.
    const cell = (v) => {
      let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(','), ...items.map((it) => cols.map((c) => cell(it[c])).join(','))].join('\r\n');
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="benchwise-audits.csv"').send(csv);
  });

  const idParam = { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] } };

  app.get('/api/v1/audits/:id', { schema: idParam }, async (req) => {
    const p = await reader(req);
    return (await store.getAudit(pool, req.params.id, { siteIds: p.siteIds })) || fail(404, 'No such audit.');
  });

  app.get('/api/v1/audits/:id/pdf', { schema: idParam }, async (req, reply) => {
    const p = await reader(req);
    const a = await store.getAudit(pool, req.params.id, { siteIds: p.siteIds });
    const file = a?.pdfSha256 && files.path(a.pdfSha256);
    if (!file || !fs.existsSync(file)) fail(404, 'No PDF for this audit.');
    const name = `${(a.serial || a.id).replace(/[^A-Za-z0-9._-]/g, '-')}.pdf`;
    return reply.type('application/pdf').header('Content-Disposition', `inline; filename="${name}"`).send(fs.createReadStream(file));
  });

  app.get('/api/v1/units/:serial', { schema: { params: { type: 'object', properties: { serial: { type: 'string', maxLength: 64 } } } } }, async (req) => {
    const p = await reader(req);
    const { items } = await store.searchAudits(pool, { serial: req.params.serial, siteIds: p.siteIds, limit: 100, newestFirst: true });
    if (!items.length) fail(404, 'No audits for this serial.');
    return { serial: items[0].serial, latest: items[0], history: items };
  });

  // ------------------------------------------------------------ staff sign-in

  app.post(
    '/api/v1/session',
    { schema: { body: { type: 'object', required: ['username', 'password'], properties: { username: { type: 'string', maxLength: 40 }, password: { type: 'string', maxLength: 256 } } } } },
    async (req, reply) => {
      const user = req.body.username.toLowerCase();
      if (!loginByIp.hit(req.ip) || !loginByUser.hit(user)) fail(429, 'Too many sign-in attempts; wait 15 minutes.');
      const token = await auth.signIn(pool, user, req.body.password, { hours: config.sessionHours });
      if (!token) fail(401, 'Wrong username or password.');
      loginByUser.reset(user);
      return reply.header('Set-Cookie', auth.sessionCookie(token, { hours: config.sessionHours, secure: config.secureCookies })).send({ ok: true });
    },
  );

  app.delete('/api/v1/session', async (req, reply) => {
    await auth.signOut(pool, req.headers.cookie);
    return reply.header('Set-Cookie', auth.clearCookie(config.secureCookies)).send({ ok: true });
  });

  app.get('/api/v1/me', async (req) => {
    const p = await principal(req);
    const sites = (await pool.query('SELECT id, code, name FROM sites ORDER BY code')).rows.filter((s) => !p.siteIds || p.siteIds.includes(s.id));
    return { kind: p.kind, name: p.name, role: p.role, sites: sites.map(({ code, name }) => ({ code, name })) };
  });

  // ------------------------------------------------------------ administration

  const siteByCode = async (code) => (await pool.query('SELECT id, code, name FROM sites WHERE code = upper($1)', [code])).rows[0] || fail(404, `No site ${code}.`);

  app.get('/api/v1/sites', async (req) => {
    await admin(req);
    return (await pool.query('SELECT code, name, time_zone, created_at FROM sites ORDER BY code')).rows;
  });

  app.post(
    '/api/v1/sites',
    { schema: { body: { type: 'object', required: ['code', 'name'], properties: { code: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9-]{1,15}$' }, name: { type: 'string', minLength: 1, maxLength: 120 }, timeZone: { type: 'string', maxLength: 64 } } } } },
    async (req, reply) => {
      const p = await admin(req);
      const { code, name, timeZone = 'America/Chicago' } = req.body;
      try {
        await pool.query('INSERT INTO sites (code, name, time_zone) VALUES (upper($1), $2, $3)', [code, name, timeZone]);
      } catch (err) {
        if (err.code === '23505') fail(409, `Site ${code.toUpperCase()} already exists.`);
        throw err;
      }
      await store.log(pool, p.name, 'site.create', { code: code.toUpperCase(), name });
      return reply.code(201).send({ code: code.toUpperCase(), name });
    },
  );

  app.get('/api/v1/stations', async (req) => {
    await admin(req);
    const r = await pool.query(`SELECT st.id, s.code AS site, st.name, st.key_prefix, st.created_at, st.last_seen_at, st.last_app_version, st.revoked_at
      FROM stations st JOIN sites s ON s.id = st.site_id ORDER BY s.code, st.name`);
    return r.rows;
  });

  app.post(
    '/api/v1/stations',
    { schema: { body: { type: 'object', required: ['site', 'name'], properties: { site: { type: 'string', maxLength: 16 }, name: { type: 'string', minLength: 1, maxLength: 80 } } } } },
    async (req, reply) => {
      const p = await admin(req);
      const site = await siteByCode(req.body.site);
      const { key, prefix, hash } = newKey('station');
      try {
        await pool.query('INSERT INTO stations (site_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4)', [site.id, req.body.name, prefix, hash]);
      } catch (err) {
        if (err.code === '23505') fail(409, `Station "${req.body.name}" already exists at ${site.code}.`);
        throw err;
      }
      await store.log(pool, p.name, 'station.create', { site: site.code, name: req.body.name, keyPrefix: prefix });
      return reply.code(201).send({ site: site.code, name: req.body.name, key, note: 'Copy this key now: it is not shown again.' });
    },
  );

  const numericId = { params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } };

  app.post('/api/v1/stations/:id/revoke', { schema: numericId }, async (req) => {
    const p = await admin(req);
    const r = await pool.query('UPDATE stations SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING name', [req.params.id]);
    if (!r.rows.length) fail(404, 'No active station with that id.');
    await store.log(pool, p.name, 'station.revoke', { id: req.params.id, name: r.rows[0].name });
    return { ok: true };
  });

  app.get('/api/v1/users', async (req) => {
    await admin(req);
    const r = await pool.query(`SELECT u.id, u.username, u.role, u.all_sites, u.created_at, u.disabled_at,
      ARRAY(SELECT s.code FROM user_sites us JOIN sites s ON s.id = us.site_id WHERE us.user_id = u.id ORDER BY s.code) AS sites
      FROM users u ORDER BY u.username`);
    return r.rows;
  });

  app.post(
    '/api/v1/users',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password', 'role'],
          properties: {
            username: { type: 'string', pattern: '^[a-z0-9._-]{3,40}$' },
            password: { type: 'string', maxLength: 256 },
            role: { type: 'string', enum: ['admin', 'lead', 'viewer'] },
            sites: { type: 'array', items: { type: 'string', maxLength: 16 }, maxItems: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      const p = await admin(req);
      const weak = checkStrength(req.body.password);
      if (weak) fail(400, weak);
      const sites = await Promise.all((req.body.sites || []).map(siteByCode));
      const allSites = req.body.role === 'admin' || !sites.length;
      const passwordHash = await hashPassword(req.body.password);
      await tx(pool, async (c) => {
        let id;
        try {
          id = (await c.query('INSERT INTO users (username, password_hash, role, all_sites) VALUES ($1, $2, $3, $4) RETURNING id', [req.body.username, passwordHash, req.body.role, allSites])).rows[0].id;
        } catch (err) {
          if (err.code === '23505') fail(409, `User ${req.body.username} already exists.`);
          throw err;
        }
        if (!allSites) for (const s of sites) await c.query('INSERT INTO user_sites (user_id, site_id) VALUES ($1, $2)', [id, s.id]);
        await store.log(c, p.name, 'user.create', { username: req.body.username, role: req.body.role, sites: allSites ? 'all' : sites.map((s) => s.code) });
      });
      return reply.code(201).send({ username: req.body.username });
    },
  );

  app.post('/api/v1/users/:id/disable', { schema: numericId }, async (req) => {
    const p = await admin(req);
    if (req.params.id === p.id) fail(400, "You can't disable your own account.");
    const r = await pool.query('UPDATE users SET disabled_at = now() WHERE id = $1 AND disabled_at IS NULL RETURNING username', [req.params.id]);
    if (!r.rows.length) fail(404, 'No active user with that id.');
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [req.params.id]);
    await store.log(pool, p.name, 'user.disable', { username: r.rows[0].username });
    return { ok: true };
  });

  app.get('/api/v1/api-clients', async (req) => {
    await admin(req);
    const r = await pool.query(`SELECT c.id, c.name, c.key_prefix, c.scopes, c.created_at, c.last_used_at, c.revoked_at,
      CASE WHEN c.site_ids IS NULL THEN NULL ELSE ARRAY(SELECT code FROM sites WHERE id = ANY(c.site_ids) ORDER BY code) END AS sites
      FROM api_clients c ORDER BY c.name`);
    return r.rows;
  });

  app.post(
    '/api/v1/api-clients',
    { schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, sites: { type: 'array', items: { type: 'string', maxLength: 16 }, maxItems: 200 } } } } },
    async (req, reply) => {
      const p = await admin(req);
      const sites = await Promise.all((req.body.sites || []).map(siteByCode));
      const { key, prefix, hash } = newKey('client');
      try {
        await pool.query('INSERT INTO api_clients (name, key_prefix, key_hash, site_ids) VALUES ($1, $2, $3, $4)', [req.body.name, prefix, hash, sites.length ? sites.map((s) => s.id) : null]);
      } catch (err) {
        if (err.code === '23505') fail(409, `An API client called "${req.body.name}" already exists.`);
        throw err;
      }
      await store.log(pool, p.name, 'api_client.create', { name: req.body.name, keyPrefix: prefix, sites: sites.length ? sites.map((s) => s.code) : 'all' });
      return reply.code(201).send({ name: req.body.name, key, note: 'Copy this key now: it is not shown again.' });
    },
  );

  app.post('/api/v1/api-clients/:id/revoke', { schema: numericId }, async (req) => {
    const p = await admin(req);
    const r = await pool.query('UPDATE api_clients SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING name', [req.params.id]);
    if (!r.rows.length) fail(404, 'No active API client with that id.');
    await store.log(pool, p.name, 'api_client.revoke', { name: r.rows[0].name });
    return { ok: true };
  });

  app.get('/api/v1/admin-log', async (req) => {
    await admin(req);
    return (await pool.query('SELECT at, actor, action, detail FROM admin_log ORDER BY id DESC LIMIT 200')).rows;
  });

  app.get('/api/v1/sites/:code/verify', async (req) => {
    await admin(req);
    const site = await siteByCode(req.params.code);
    return { site: site.code, ...(await store.verifyChain(pool, site.id)) };
  });

  return app;
}

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const app = buildApp({ pool, config });
  const stop = async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await app.listen({ host: config.host, port: config.port });
  if (config.tlsCert && config.httpRedirectPort) {
    // Plain HTTP only redirects to HTTPS (nothing is served unencrypted).
    const http = require('node:http');
    const httpsPort = config.port === 443 ? '' : `:${config.port}`;
    http
      .createServer((req, res) => {
        const host = String(req.headers.host || '').replace(/:\d+$/, '') || 'localhost';
        res.writeHead(301, { Location: `https://${host}${httpsPort}${req.url}` }).end();
      })
      .listen(config.httpRedirectPort, config.host);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { buildApp };
