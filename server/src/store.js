'use strict';

// Everything the server does with the database. Routes call these; nothing
// else touches SQL. Every query is parameterised. (Servers store records
// only; PDFs are drawn from a record on demand, never stored.)

const { tx } = require('./db');
const { canonicalJson, sha256, chainHash, extractFields } = require('./records');

// ---------------------------------------------------------------- audits

/**
 * Adds one record. Idempotent on record.id: the same record again returns the
 * stored row; a DIFFERENT record with the same id is a conflict.
 * The per-site advisory lock keeps the hash chain strictly ordered.
 */
async function insertAudit(pool, { record, station }) {
  const recordSha = sha256(canonicalJson(record));
  const f = extractFields(record);
  return tx(pool, async (c) => {
    const existing = await c.query('SELECT id, seq, record_sha256, site_id FROM audits WHERE id = $1', [record.id]);
    if (existing.rows.length) {
      const row = existing.rows[0];
      return row.record_sha256 === recordSha ? { status: 'duplicate', id: row.id, seq: Number(row.seq) } : { status: 'conflict', id: row.id };
    }
    await c.query('SELECT pg_advisory_xact_lock(7151, $1)', [station.site_id]);
    const prev = await c.query('SELECT hash FROM audits WHERE site_id = $1 ORDER BY seq DESC LIMIT 1', [station.site_id]);
    const prevHash = prev.rows[0]?.hash || null;
    const year = new Date(f.completedAt).getUTCFullYear();
    const ins = await c.query(
      `INSERT INTO audits (id, site_id, station_id, schema, schema_version, serial, uuid, asset_tag, manufacturer, model,
         profile, overall, mdm_status, malware_status, technician, app_version, completed_at, record_year, record_sha256,
         prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING seq`,
      [
        record.id, station.site_id, station.id, record.schema, record.schemaVersion, f.serial, f.uuid, f.assetTag,
        f.manufacturer, f.model, f.profile, f.overall, f.mdmStatus, f.malwareStatus, f.technician, f.appVersion,
        f.completedAt, year, recordSha, prevHash, chainHash(prevHash, recordSha),
      ],
    );
    await c.query('INSERT INTO audit_records (record_year, audit_id, record) VALUES ($1, $2, $3)', [year, record.id, record]);
    await c.query('UPDATE stations SET last_seen_at = now(), last_app_version = $2 WHERE id = $1', [station.id, f.appVersion]);
    return { status: 'created', id: record.id, seq: Number(ins.rows[0].seq) };
  });
}

const SUMMARY_COLUMNS = `a.id, a.seq, s.code AS site, st.name AS station, a.serial, a.uuid, a.asset_tag, a.manufacturer, a.model,
  a.profile, a.overall, a.mdm_status, a.malware_status, a.technician, a.app_version, a.completed_at, a.received_at`;

function summary(row) {
  return {
    id: row.id,
    cursor: String(row.seq),
    site: row.site,
    station: row.station,
    serial: row.serial,
    uuid: row.uuid,
    assetTag: row.asset_tag,
    manufacturer: row.manufacturer,
    model: row.model,
    profile: row.profile,
    overall: row.overall,
    mdm: row.mdm_status,
    malware: row.malware_status,
    technician: row.technician,
    appVersion: row.app_version,
    completedAt: row.completed_at,
    receivedAt: row.received_at,
  };
}

/**
 * Search and incremental export. `since` is a cursor: results are in arrival
 * order after it, so a WMS can keep pulling "everything new".
 * `siteIds` (null = all) is the caller's access, always applied.
 */
async function searchAudits(pool, { siteIds = null, serial, serials, site, overall, profile, q, since, from, to, limit = 50, newestFirst = !since }) {
  const where = [];
  const args = [];
  const add = (sql, v) => {
    args.push(v);
    where.push(sql.replace('?', `$${args.length}`));
  };
  if (siteIds) add('a.site_id = ANY(?)', siteIds);
  if (serial) add('upper(a.serial) = upper(?)', serial);
  if (site) add('s.code = upper(?)', site);
  if (overall) add('a.overall = ?', overall);
  if (profile) add('a.profile = ?', profile);
  if (since) add('a.seq > ?', since);
  if (from) add('a.completed_at >= ?', from);
  if (to) add('a.completed_at < ?', to);
  if (serials?.length) add('upper(a.serial) = ANY(?)', serials.map((x) => x.toUpperCase()));
  if (q) {
    args.push(`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    const p = `$${args.length}`;
    where.push(`(a.serial ILIKE ${p} OR a.asset_tag ILIKE ${p} OR a.model ILIKE ${p} OR a.manufacturer ILIKE ${p} OR a.uuid ILIKE ${p})`);
  }
  args.push(Math.min(Math.max(Number(limit) || 50, 1), 500));
  const sql = `SELECT ${SUMMARY_COLUMNS} FROM audits a JOIN sites s ON s.id = a.site_id JOIN stations st ON st.id = a.station_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY a.seq ${newestFirst ? 'DESC' : 'ASC'} LIMIT $${args.length}`;
  const rows = (await pool.query(sql, args)).rows.map(summary);
  return { items: rows, nextCursor: !newestFirst && rows.length ? rows[rows.length - 1].cursor : null };
}

async function getAudit(pool, id, { siteIds = null } = {}) {
  const args = [id];
  let cond = 'a.id = $1';
  if (siteIds) {
    args.push(siteIds);
    cond += ' AND a.site_id = ANY($2)';
  }
  const r = await pool.query(
    `SELECT ${SUMMARY_COLUMNS}, r.record, a.hash, a.prev_hash FROM audits a
     JOIN audit_records r ON r.record_year = a.record_year AND r.audit_id = a.id
     JOIN sites s ON s.id = a.site_id JOIN stations st ON st.id = a.station_id WHERE ${cond}`,
    args,
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return { ...summary(row), record: row.record, hash: row.hash, prevHash: row.prev_hash };
}

/**
 * Re-computes a site's chain from the stored records, in batches, so it works
 * at tens of millions of records without loading them all at once.
 */
async function verifyChain(pool, siteId, { batch = 5000 } = {}) {
  let prev = null;
  let after = 0;
  let checked = 0;
  for (;;) {
    const r = await pool.query(
      `SELECT a.id, a.seq, a.record_sha256, a.prev_hash, a.hash, r.record FROM audits a
       JOIN audit_records r ON r.record_year = a.record_year AND r.audit_id = a.id
       WHERE a.site_id = $1 AND a.seq > $2 ORDER BY a.seq LIMIT $3`,
      [siteId, after, batch],
    );
    for (const row of r.rows) {
      checked += 1;
      const recordSha = sha256(canonicalJson(row.record));
      if (recordSha !== row.record_sha256) return { ok: false, checked, brokenAt: row.id, reason: 'record changed' };
      if ((row.prev_hash || null) !== prev) return { ok: false, checked, brokenAt: row.id, reason: 'chain link missing' };
      if (chainHash(prev, recordSha) !== row.hash) return { ok: false, checked, brokenAt: row.id, reason: 'hash mismatch' };
      prev = row.hash;
      after = row.seq;
    }
    if (r.rows.length < batch) return { ok: true, checked, head: prev };
  }
}

// ---------------------------------------------------------------- admin data

const log = (db, actor, action, detail = {}) => db.query('INSERT INTO admin_log (actor, action, detail) VALUES ($1, $2, $3)', [actor, action, detail]);

/** Full records for a list of audit ids (export), within the caller's sites. */
async function getAudits(pool, ids, { siteIds = null } = {}) {
  if (!ids.length) return [];
  const args = [ids];
  let cond = 'a.id = ANY($1)';
  if (siteIds) {
    args.push(siteIds);
    cond += ' AND a.site_id = ANY($2)';
  }
  const r = await pool.query(
    `SELECT ${SUMMARY_COLUMNS}, r.record, a.hash, a.prev_hash FROM audits a
     JOIN audit_records r ON r.record_year = a.record_year AND r.audit_id = a.id
     JOIN sites s ON s.id = a.site_id JOIN stations st ON st.id = a.station_id WHERE ${cond} ORDER BY a.seq`,
    args,
  );
  return r.rows.map((row) => ({ ...summary(row), record: row.record, hash: row.hash, prevHash: row.prev_hash }));
}

module.exports = { insertAudit, searchAudits, getAudit, getAudits, verifyChain, log };
