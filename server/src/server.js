'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Fastify = require('fastify');
const { loadConfig } = require('./config');
const { createPool, tx } = require('./db');
const { validateRecord } = require('./records');
const store = require('./store');
const auth = require('./auth');
const { newKey } = require('./keys');
const { hashPassword, checkStrength } = require('./passwords');
const setup = require('./setup');
const wifiCfg = require('./wifi');
const sticks = require('./sticks');
const crypto = require('node:crypto');
const { version } = require('../package.json');
const yazl = require('yazl');
const { renderRecordPdf, pdfName } = require('./report');

const MAX_EXPORT = 5000; // records per ZIP export
const CSV_COLUMNS = ['completedAt', 'site', 'station', 'serial', 'assetTag', 'manufacturer', 'model', 'profile', 'overall', 'mdm', 'malware', 'technician', 'appVersion', 'id'];

/** CSV, safe from spreadsheet formula injection (a cell starting with = + - @ gets a leading '). */
function toCsv(items) {
  const cell = (v) => {
    let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLUMNS.join(','), ...items.map((it) => CSV_COLUMNS.map((c) => cell(it[c])).join(','))].join('\r\n');
}

/** Query filters -> search options (serials: comma/space/newline separated). */
function filters(q) {
  const serials = q.serials ? [...new Set(q.serials.split(/[\s,;]+/).filter(Boolean))].slice(0, 2000) : null;
  return { ...q, serials, from: q.from || null, to: q.to || null };
}

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

/**
 * The web application for one network side:
 *   'floor'  station uploads only (the floor / test network)
 *   'staff'  web pages, search, exports, administration (the company network)
 *   'both'   everything (a server on a single network)
 */
// listDrives is injectable for tests (a CI machine has no USB stick to list).
function buildApp({ pool, config = loadConfig(), side = 'both', logger = true, listDrives = sticks.listDrives } = {}) {
  const floor = side === 'floor' || side === 'both';
  const staff = side === 'staff' || side === 'both';
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

  if (floor) registerFloor();
  if (staff) registerStaff();
  return app;

  /** A root-helper job's status file, or null. */
  function jobStatus(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(config.statusDir, `${id}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ first-run setup wizard
  // Open only while setup is pending (the installer stores a one-time code);
  // closed for good once it completes.
  function registerSetup() {
    const tokens = new Map(); // hash -> expiry (one server process; setup is a one-off)
    const codeTries = auth.rateLimiter({ max: 6, windowMs: 15 * 60_000 });
    const pending = async () => {
      const st = await setup.getSetting(pool, 'setup');
      return st && !st.complete ? st : null;
    };
    const withToken = async (req) => {
      if (!(await pending())) fail(409, 'This server is already set up.');
      const t = String(req.headers['x-setup-token'] || '');
      const h = crypto.createHash('sha256').update(t).digest('hex');
      const exp = tokens.get(h);
      if (!exp || exp < Date.now()) fail(401, 'Enter the setup code again (the setup session expired).');
    };

    app.get('/api/v1/setup/status', async () => ({ needed: Boolean(await pending()) }));

    app.post('/api/v1/setup/verify', { schema: { body: { type: 'object', required: ['code'], properties: { code: { type: 'string', maxLength: 32 } } } } }, async (req) => {
      const st = await pending();
      if (!st) fail(409, 'This server is already set up.');
      if (codeTries.blocked(req.ip)) fail(429, 'Too many wrong codes; wait 15 minutes.');
      const a = Buffer.from(setup.hashCode(req.body.code));
      const b = Buffer.from(String(st.codeHash || ''));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        codeTries.hit(req.ip);
        fail(401, "That setup code isn't right. It was printed at the end of the install.");
      }
      const token = crypto.randomBytes(32).toString('base64url');
      tokens.set(crypto.createHash('sha256').update(token).digest('hex'), Date.now() + 30 * 60_000);
      return { token };
    });

    app.get('/api/v1/setup/environment', async (req) => {
      await withToken(req);
      let fingerprint = null;
      try {
        fingerprint = new crypto.X509Certificate(fs.readFileSync(config.certPath)).fingerprint256;
      } catch {
        /* not readable here (development) */
      }
      return { interfaces: setup.localInterfaces(), timeZones: setup.TIME_ZONES, generatedCertificate: { fingerprint }, twoNetworksNow: Boolean(config.floor) };
    });

    app.post('/api/v1/setup/apply', { bodyLimit: 512 * 1024, schema: { body: { type: 'object' } } }, async (req) => {
      await withToken(req);
      const interfaces = setup.localInterfaces();
      const { errors, plan } = setup.checkSetup(req.body, { interfaces });
      if (errors) return { ok: false, errors };
      const id = crypto.randomUUID();
      const passwordHash = await hashPassword(plan.admin.password);
      await tx(pool, async (c) => {
        const site = await c.query(
          `INSERT INTO sites (code, name, time_zone) VALUES ($1, $2, $3)
           ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, time_zone = EXCLUDED.time_zone RETURNING id`,
          [plan.site.code, plan.site.name, plan.site.timeZone],
        );
        try {
          await c.query("INSERT INTO users (username, password_hash, role, all_sites, origin) VALUES ($1, $2, 'admin', true, 'local')", [plan.admin.username, passwordHash]);
        } catch (err) {
          if (err.code === '23505') fail(409, `A user called ${plan.admin.username} already exists.`);
          throw err;
        }
        await setup.setSetting(c, 'site.home', { siteId: site.rows[0].id, code: plan.site.code });
        await setup.setSetting(c, 'network', plan.network);
        await setup.setSetting(c, 'certificate', { mode: plan.certificate.mode });
        if (plan.wifi) await setup.setSetting(c, 'sticks.wifi', { ...plan.wifi, updatedAt: new Date().toISOString() });
        await setup.setSetting(c, 'setup', { complete: true, completedAt: new Date().toISOString(), applyId: id });
        await store.log(c, plan.admin.username, 'setup.complete', { site: plan.site.code, network: plan.network.mode, certificate: plan.certificate.mode, wifi: Boolean(plan.wifi) });
      });
      tokens.clear();
      // Network and certificate need root: hand them to the apply helper.
      setup.writeApplyRequest(config.requestsDir, { id, type: 'setup', network: plan.network, certificate: plan.certificate });
      const url = `https://${plan.network.mode === 'two' ? plan.network.companyIp : req.hostname.replace(/:\d+$/, '')}/`;
      return { ok: true, applyId: id, url };
    });

    // Progress of the root helper's setup job (no secrets in it).
    app.get('/api/v1/setup/progress', async () => {
      const id = (await setup.getSetting(pool, 'setup'))?.applyId;
      const st = id && jobStatus(id);
      return st ? { state: st.state, message: st.message || null, url: st.url || null, at: st.at } : { state: 'waiting' };
    });
  }

  // ------------------------------------------------------------ floor side: stations
  function registerFloor() {

  app.get('/api/v1/station', async (req) => {
    const st = await principal(req, { station: true });
    return { station: st.name, site: { code: st.site_code, name: st.site_name } };
  });

  // The current floor Wi-Fi as a Windows WLAN profile, so a stick that
  // reaches the server (even over a cable) can refresh its wifi.xml.
  app.get('/api/v1/station/wifi', async (req, reply) => {
    await principal(req, { station: true });
    const w = await setup.getSetting(pool, 'sticks.wifi');
    if (!w) return reply.code(204).send();
    return { ...wifiCfg.publicView(w), profileXml: wifiCfg.wlanProfileXml(w) };
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
          properties: { record: { type: 'object' } },
        },
      },
    },
    async (req, reply) => {
      const st = await principal(req, { station: true });
      const { record } = req.body;
      const problem = validateRecord(record);
      if (problem) fail(400, `Invalid record: ${problem}`);
      let res;
      try {
        res = await store.insertAudit(pool, { record, station: st });
      } catch (err) {
        if (err.code !== '23505') throw err; // two uploads of the same record at once
        res = { status: 'duplicate', id: record.id };
      }
      if (res.status === 'conflict') fail(409, 'A different record with this id already exists.');
      return reply.code(res.status === 'created' ? 201 : 200).send(res);
    },
  );
  }

  // ------------------------------------------------------------ staff side
  function registerStaff() {
  registerSetup();
  for (const [route, [file, type]] of Object.entries(STATIC)) {
    const body = fs.readFileSync(path.join(PUBLIC, file));
    app.get(route, async (req, reply) => reply.type(type).header('Cache-Control', 'no-cache').send(body));
  }

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
        from: { type: 'string', format: 'date' },
        to: { type: 'string', format: 'date' },
        serials: { type: 'string', maxLength: 64000 },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
    },
  };

  app.get('/api/v1/audits', { schema: searchSchema }, async (req) => {
    const p = await reader(req);
    return store.searchAudits(pool, { ...filters(req.query), siteIds: p.siteIds });
  });

  app.get('/api/v1/audits.csv', { schema: searchSchema }, async (req, reply) => {
    const p = await reader(req);
    const { items } = await store.searchAudits(pool, { ...filters(req.query), limit: 500, siteIds: p.siteIds });
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="benchwise-audits.csv"').send(toCsv(items));
  });

  // Compliance export: a ZIP of one PDF per record plus a CSV summary, drawn
  // from the stored records on request (never stored). Logged.
  app.get('/api/v1/export.zip', { schema: searchSchema }, async (req, reply) => {
    const p = await reader(req);
    const f = filters(req.query);
    if (!f.from && !f.to && !f.serials && !f.serial && !f.site) fail(400, 'Choose a date range, a site or serial numbers to export.');
    const items = [];
    let since = '0';
    for (;;) {
      const page = await store.searchAudits(pool, { ...f, siteIds: p.siteIds, since, limit: 500, newestFirst: false });
      items.push(...page.items);
      if (items.length > MAX_EXPORT) fail(413, `More than ${MAX_EXPORT} records match: narrow the export (for example a shorter date range).`);
      if (page.items.length < 500) break;
      since = page.nextCursor;
    }
    if (!items.length) fail(404, 'No records match.');
    await store.log(pool, p.name, 'export.zip', { records: items.length, filters: { site: f.site, from: f.from, to: f.to, serial: f.serial, serials: f.serials?.length, overall: f.overall, profile: f.profile } });

    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(toCsv(items), 'utf8'), 'summary.csv');
    const used = new Set();
    (async () => {
      for (let i = 0; i < items.length; i += 100) {
        for (const a of await store.getAudits(pool, items.slice(i, i + 100).map((x) => x.id), { siteIds: p.siteIds })) {
          let name = `pdfs/${pdfName(a)}`;
          if (used.has(name)) name = name.replace(/\.pdf$/, `_${a.id.slice(0, 8)}.pdf`);
          used.add(name);
          zip.addBuffer(await renderRecordPdf(a), name, { compress: false }); // PDFs are already compressed
        }
      }
      zip.end();
    })().catch((err) => {
      req.log.error(err);
      zip.outputStream.destroy(err);
    });
    const stamp = new Date().toISOString().slice(0, 10);
    return reply.type('application/zip').header('Content-Disposition', `attachment; filename="benchwise-export-${stamp}.zip"`).send(zip.outputStream);
  });

  const idParam = { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] } };

  app.get('/api/v1/audits/:id', { schema: idParam }, async (req) => {
    const p = await reader(req);
    return (await store.getAudit(pool, req.params.id, { siteIds: p.siteIds })) || fail(404, 'No such audit.');
  });

  app.get('/api/v1/audits/:id/report.pdf', { schema: idParam }, async (req, reply) => {
    const p = await reader(req);
    const a = (await store.getAudit(pool, req.params.id, { siteIds: p.siteIds })) || fail(404, 'No such audit.');
    return reply.type('application/pdf').header('Content-Disposition', `inline; filename="${pdfName(a)}"`).send(await renderRecordPdf(a));
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

  app.get('/api/v1/settings/wifi', async (req) => {
    await admin(req);
    return { wifi: wifiCfg.publicView(await setup.getSetting(pool, 'sticks.wifi')), securityOptions: Object.entries(wifiCfg.SECURITY).map(([value, s]) => ({ value, label: s.label })) };
  });

  app.put(
    '/api/v1/settings/wifi',
    { schema: { body: { type: 'object', properties: { ssid: { type: 'string', maxLength: 64 }, password: { type: 'string', maxLength: 128 }, security: { type: 'string', maxLength: 10 }, hidden: { type: 'boolean' }, clear: { type: 'boolean' } } } } },
    async (req) => {
      const p = await admin(req);
      if (req.body.clear) {
        await pool.query("DELETE FROM server_settings WHERE key = 'sticks.wifi'");
        await store.log(pool, p.name, 'wifi.clear', {});
        return { wifi: null };
      }
      const current = await setup.getSetting(pool, 'sticks.wifi');
      // An empty password field means "keep the current password".
      const body = { ...req.body, password: req.body.password || (req.body.security !== 'open' ? current?.password : '') };
      const { errors, wifi } = wifiCfg.checkWifi(body);
      if (errors) fail(400, errors.join(' '));
      const stored = { ...wifi, updatedAt: new Date().toISOString() };
      await setup.setSetting(pool, 'sticks.wifi', stored);
      await store.log(pool, p.name, 'wifi.update', { ssid: wifi.ssid, security: wifi.security, hidden: wifi.hidden, passwordChanged: Boolean(req.body.password) });
      return { wifi: wifiCfg.publicView(stored) };
    },
  );

  // ------------------------------------------------------------ USB sticks (made at this server)

  const appZip = () => path.join(config.sticksDir, 'app.zip');

  /** The address sticks reach this server on: the floor side, or the only network. */
  async function stickDefaults() {
    // The running mode wins over the wizard's saved choice: the installer can
    // change it later (--one-network / --floor-ip), and then the setting is stale.
    const net = (await setup.getSetting(pool, 'network')) || { mode: 'one' };
    const twoNetworks = Boolean(config.floor) && net.mode === 'two';
    const serverAddress = twoNetworks ? net.floorIp : setup.localInterfaces()[0]?.address || null;
    const certMode = (await setup.getSetting(pool, 'certificate'))?.mode || 'generated';
    let fingerprint = null;
    if (certMode !== 'upload') {
      try {
        fingerprint = new crypto.X509Certificate(fs.readFileSync(config.certPath)).fingerprint256;
      } catch {
        fingerprint = null;
      }
    }
    return { serverAddress, certMode, fingerprint };
  }

  app.get('/api/v1/sticks', async (req) => {
    await admin(req);
    const [build, drives, wifi, defaults] = await Promise.all([setup.getSetting(pool, 'sticks.app'), listDrives(), setup.getSetting(pool, 'sticks.wifi'), stickDefaults()]);
    let tooOld = null;
    if (build) {
      try {
        sticks.checkStickVersion(build.version);
      } catch (err) {
        tooOld = err.message;
      }
    }
    return { app: build && fs.existsSync(appZip()) ? { ...build, tooOld } : null, minVersion: sticks.MIN_STICK_VERSION, drives, wifi: wifiCfg.publicView(wifi), defaults };
  });

  app.post('/api/v1/sticks/app/fetch', { schema: { body: { type: 'object', properties: { includePrerelease: { type: 'boolean' } } } } }, async (req) => {
    const p = await admin(req);
    fs.mkdirSync(config.sticksDir, { recursive: true });
    const meta = await sticks.fetchRelease({ repo: config.releasesRepo, includePrerelease: Boolean(req.body?.includePrerelease), dest: appZip() });
    const stored = { ...meta, at: new Date().toISOString() };
    await setup.setSetting(pool, 'sticks.app', stored);
    await store.log(pool, p.name, 'sticks.app', { version: meta.version, source: 'github', verified: meta.verified });
    return { app: stored };
  });

  // Upload a build (the "-win-x64.zip" from a release), streamed to disk.
  app.addContentTypeParser('application/zip', (req, payload, done) => done(null, payload));
  app.put('/api/v1/sticks/app', { bodyLimit: 700 * 1024 * 1024 }, async (req) => {
    const p = await admin(req);
    const name = String(req.query?.name || '');
    const version = sticks.versionFromFileName(name);
    try {
      sticks.checkStickVersion(version);
    } catch (err) {
      req.raw.resume(); // drain the upload; nothing is stored
      fail(400, err.message);
    }
    fs.mkdirSync(config.sticksDir, { recursive: true });
    const tmp = `${appZip()}.upload`;
    let size = 0;
    const out = fs.createWriteStream(tmp, { mode: 0o640 });
    try {
      for await (const chunk of req.body) {
        size += chunk.length;
        if (size > 700 * 1024 * 1024) fail(413, 'The file is too large for a Benchwise build.');
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      await sticks.inspectZip(tmp);
    } catch (err) {
      out.destroy();
      fs.rmSync(tmp, { force: true });
      if (err.statusCode) throw err;
      fail(400, err.message);
    }
    fs.renameSync(tmp, appZip());
    const meta = { version, file: name, sha256: await sticks.sha256File(appZip()), source: 'upload', at: new Date().toISOString() };
    await setup.setSetting(pool, 'sticks.app', meta);
    await store.log(pool, p.name, 'sticks.app', { version: meta.version, source: 'upload', sha256: meta.sha256 });
    return { app: meta };
  });

  app.post(
    '/api/v1/sticks',
    { schema: { body: { type: 'object', required: ['device'], properties: { device: { type: 'string', maxLength: 16 }, serial: { type: ['string', 'null'], maxLength: 128 }, name: { type: 'string', maxLength: 60 }, serverAddress: { type: 'string', maxLength: 253 } } } } },
    async (req, reply) => {
      const p = await admin(req);
      const build = await setup.getSetting(pool, 'sticks.app');
      if (!build || !fs.existsSync(appZip())) fail(409, 'Get the Benchwise build for sticks first.');
      try {
        sticks.checkStickVersion(build.version);
      } catch (err) {
        fail(409, `${err.message} Get a newer build first.`);
      }
      const drive = (await listDrives()).find((d) => d.name === req.body.device);
      if (!drive) fail(404, 'That drive is no longer plugged in. Refresh the list.');
      if (!drive.eligible) fail(400, `That drive can't be used: ${drive.why}.`);
      const home = (await setup.getSetting(pool, 'site.home')) || null;
      const site = home ? (await pool.query('SELECT id, code, name FROM sites WHERE id = $1', [home.siteId])).rows[0] : (await pool.query('SELECT id, code, name FROM sites ORDER BY id LIMIT 1')).rows[0];
      if (!site) fail(409, 'Set up this facility first.');
      const defaults = await stickDefaults();
      const address = (req.body.serverAddress || defaults.serverAddress || '').trim();
      if (!/^[A-Za-z0-9.-]{1,253}$/.test(address)) fail(400, 'Server address: an IP address or host name that sticks can reach.');
      const wifi = await setup.getSetting(pool, 'sticks.wifi');

      // Each stick is its own station: a lost stick can be revoked alone.
      const count = (await pool.query("SELECT count(*)::int AS n FROM stations WHERE site_id = $1 AND name LIKE 'Stick %'", [site.id])).rows[0].n;
      const stationName = (req.body.name || `Stick ${count + 1}`).trim();
      const { key, prefix, hash } = newKey('station');
      let stationId;
      try {
        stationId = (await pool.query('INSERT INTO stations (site_id, name, key_prefix, key_hash) VALUES ($1, $2, $3, $4) RETURNING id', [site.id, stationName, prefix, hash])).rows[0].id;
      } catch (err) {
        if (err.code === '23505') fail(409, `A station called "${stationName}" already exists.`);
        throw err;
      }
      const id = crypto.randomUUID();
      const serverUrl = `https://${address}`;
      try {
        setup.writeApplyRequest(config.requestsDir, {
          id,
          type: 'stick',
          device: drive.name,
          serial: drive.serial,
          siteCmd: sticks.buildSiteCmd({ serverUrl, key, fingerprint: defaults.fingerprint, wifiName: wifi?.ssid }),
          wifiXml: wifi ? wifiCfg.wlanProfileXml(wifi) : null,
          readme: sticks.buildReadme({ site: `${site.code} · ${site.name}`, stationName, server: serverUrl, version: build.version, madeAt: new Date().toISOString() }),
        });
      } catch (err) {
        await pool.query('UPDATE stations SET revoked_at = now() WHERE id = $1', [stationId]);
        throw err;
      }
      await setup.setSetting(pool, `stickjob.${id.replace(/-/g, '')}`, { stationId, stationName, device: drive.name, model: drive.model, by: p.name });
      await store.log(pool, p.name, 'stick.make', { station: stationName, drive: `${drive.model} ${drive.size}`, serial: drive.serial, keyPrefix: prefix });
      return reply.code(202).send({ jobId: id, station: stationName });
    },
  );

  app.get('/api/v1/sticks/jobs/:id', { schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } } }, async (req) => {
    await admin(req);
    const st = jobStatus(req.params.id) || { state: 'queued' };
    const key = `stickjob.${req.params.id.replace(/-/g, '')}`;
    const job = await setup.getSetting(pool, key);
    if (st.state === 'failed' && job && !job.revoked) {
      // A stick that wasn't made mustn't leave a usable key behind.
      await pool.query('UPDATE stations SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [job.stationId]);
      await setup.setSetting(pool, key, { ...job, revoked: true });
    }
    return { state: st.state, step: st.step || null, message: st.message || null, drive: st.drive || null, station: job?.stationName || null };
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
  }
}

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  // Two networks: staff side and floor side on separate addresses.
  // One network (e.g. directly on an existing warehouse network): both on one.
  const apps = config.floor
    ? [
        [buildApp({ pool, config, side: 'staff' }), config.host, config.port],
        [buildApp({ pool, config, side: 'floor' }), config.floor.host, config.floor.port],
      ]
    : [[buildApp({ pool, config, side: 'both' }), config.host, config.port]];
  const stop = async () => {
    await Promise.all(apps.map(([a]) => a.close()));
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  for (const [a, host, port] of apps) await a.listen({ host, port });
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
