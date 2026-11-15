'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { overallStatus, validateAssetTag, TEST_STATUSES } = require('../hardware/normalize');
const { giveToOwner } = require('../elevation');

const SCHEMA = 'qudit.audit';
const SCHEMA_VERSION = 1;

function stamp(iso) {
  return iso.replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');
}

function str(x, max) {
  return typeof x === 'string' ? x.trim().slice(0, max) : '';
}

/** Keep only well-formed test results; anything unexpected becomes 'untested'. */
function sanitizeTests(tests, enabledIds) {
  const out = {};
  for (const id of enabledIds) {
    const t = tests?.[id] || {};
    out[id] = {
      status: TEST_STATUSES.includes(t.status) ? t.status : 'untested',
      notes: str(t.notes, 2000),
      // Keys starting with "_" are UI-only state (e.g. keyboard key sets).
      details:
        t.details && typeof t.details === 'object'
          ? Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(t.details))).filter(([k]) => !k.startsWith('_')))
          : {},
      completedAt: typeof t.completedAt === 'string' ? t.completedAt : null,
    };
  }
  return out;
}

/**
 * Builds the canonical audit record. The main process owns the hardware
 * snapshot; the renderer only contributes operator input and test results.
 */
function buildAudit({ input, hardware, settings, app }) {
  const tag = validateAssetTag(input.assetTag, settings.assetTagPattern);
  if (!tag.ok) throw new Error(tag.error);
  const enabledIds = Object.entries(settings.enabledTests)
    .filter(([, on]) => on)
    .map(([id]) => id);
  const tests = sanitizeTests(input.tests, enabledIds);
  const media = input.media || {};
  const list = (xs) => (Array.isArray(xs) ? xs.slice(0, 20).map((x) => str(x, 200)).filter(Boolean) : []);
  return {
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    id: crypto.randomUUID(),
    assetTag: tag.value,
    assetTagLabel: settings.assetTagLabel,
    technician: str(input.technician, 80),
    station: settings.stationName,
    notes: str(input.notes, 4000),
    startedAt: typeof input.startedAt === 'string' ? input.startedAt : null,
    completedAt: new Date().toISOString(),
    app,
    overall: overallStatus(tests),
    hardware,
    media: { cameras: list(media.cameras), microphones: list(media.microphones), speakers: list(media.speakers) },
    tests,
  };
}

class ReportStore {
  /** @param {() => string} dirFn  @param {(audit) => Promise<Buffer>} renderPdf */
  constructor(dirFn, renderPdf) {
    this.dirFn = dirFn;
    this.renderPdf = renderPdf;
  }

  get dir() {
    return this.dirFn();
  }

  async #uniqueBase(base) {
    for (let i = 1; ; i++) {
      const name = i === 1 ? base : `${base}-${i}`;
      try {
        await fs.access(path.join(this.dir, `${name}.json`));
      } catch {
        return name;
      }
    }
  }

  async #writeAtomic(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  }

  /** Saves JSON + PDF. Never overwrites an existing report. */
  async save(audit) {
    await fs.mkdir(this.dir, { recursive: true });
    const base = await this.#uniqueBase(`${audit.assetTag}_${stamp(audit.completedAt)}`);
    const jsonPath = path.join(this.dir, `${base}.json`);
    const pdfPath = path.join(this.dir, `${base}.pdf`);
    await this.#writeAtomic(jsonPath, JSON.stringify(audit, null, 2));
    let pdfError = null;
    try {
      await this.#writeAtomic(pdfPath, await this.renderPdf(audit));
    } catch (err) {
      pdfError = err.message; // the JSON is the record of truth; keep it even if PDF fails
    }
    giveToOwner(this.dir, jsonPath, pdfError ? null : pdfPath); // elevated on Linux: keep files the operator's
    return { file: base, jsonPath, pdfPath: pdfError ? null : pdfPath, pdfError };
  }

  async list() {
    let names;
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const rows = await Promise.all(
      names
        .filter((f) => f.endsWith('.json'))
        .map(async (f) => {
          try {
            const a = JSON.parse(await fs.readFile(path.join(this.dir, f), 'utf8'));
            if (a.schema !== SCHEMA) return null;
            const base = f.slice(0, -5);
            const hasPdf = await fs.access(path.join(this.dir, `${base}.pdf`)).then(() => true, () => false);
            return {
              file: base,
              id: a.id,
              assetTag: a.assetTag,
              completedAt: a.completedAt,
              overall: a.overall,
              technician: a.technician,
              manufacturer: a.hardware?.system?.manufacturer || null,
              model: a.hardware?.system?.model || null,
              serial: a.hardware?.system?.serial || null,
              hasPdf,
            };
          } catch {
            return null;
          }
        }),
    );
    return rows.filter(Boolean).sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
  }

  /** Resolves a report file strictly inside the reports directory. */
  resolve(file, ext) {
    if (typeof file !== 'string' || !/^[A-Za-z0-9._-]+$/.test(file) || file.includes('..')) {
      throw new Error('Invalid report name');
    }
    if (!['json', 'pdf'].includes(ext)) throw new Error('Invalid report type');
    const full = path.resolve(this.dir, `${file}.${ext}`);
    if (path.dirname(full) !== path.resolve(this.dir)) throw new Error('Invalid report path');
    return full;
  }
}

module.exports = { ReportStore, buildAudit, SCHEMA, SCHEMA_VERSION };
