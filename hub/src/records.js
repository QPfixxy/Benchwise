'use strict';

// Benchwise audit records: validation, the searchable columns copied out of
// them, and the per-site hash chain that makes the record store
// tamper-evident.

const crypto = require('node:crypto');

const SCHEMAS = ['qudit.audit']; // the Benchwise record schema id (kept since Qudit)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** JSON with object keys sorted at every level: the same record always hashes the same. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** Hash of one link in a site's chain: previous link + this record. */
function chainHash(prevHash, recordSha) {
  return sha256(`${prevHash || 'genesis'}\n${recordSha}`);
}

/** Basic shape checks beyond the request schema. Returns an error message or null. */
function validateRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'record must be an object';
  if (!SCHEMAS.includes(r.schema)) return `unsupported schema "${r.schema}"`;
  if (!Number.isInteger(r.schemaVersion) || r.schemaVersion < 1) return 'schemaVersion must be a positive integer';
  if (!UUID.test(String(r.id || ''))) return 'id must be a UUID';
  if (!r.completedAt || Number.isNaN(Date.parse(r.completedAt))) return 'completedAt must be a date';
  if (!r.tests || typeof r.tests !== 'object') return 'tests must be an object';
  return null;
}

const str = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** The columns the Hub searches on, copied out of the record (the record itself stays whole). */
function extractFields(r) {
  const sys = r.hardware?.system || {};
  const intake = r.hardware?.intake || {};
  const test = (id) => r.tests?.[id] || null;
  return {
    serial: str(r.serial) || str(sys.serial),
    uuid: str(r.uuid) || str(sys.uuid),
    assetTag: str(r.assetTag, 64),
    manufacturer: str(sys.manufacturer),
    model: str(sys.model),
    profile: str(r.profile, 20) || 'full',
    overall: str(r.overall, 20),
    // The check's own outcome (clean / locked / ghost / infected...), else the test verdict.
    mdmStatus: str(intake.mdm?.status, 20) || str(test('mdm')?.details?.result, 20) || str(test('mdm')?.status, 20),
    malwareStatus: str(intake.malware?.status, 20) || str(test('malware')?.details?.result, 20) || str(test('malware')?.status, 20),
    technician: str(r.technician, 80),
    completedAt: new Date(r.completedAt).toISOString(),
    appVersion: str(r.app?.version, 40),
  };
}

/** True if the bytes look like a PDF. */
const isPdf = (buf) => Buffer.isBuffer(buf) && buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-';

module.exports = { canonicalJson, sha256, chainHash, validateRecord, extractFields, isPdf, SCHEMAS };
