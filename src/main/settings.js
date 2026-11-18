'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { giveToOwner } = require('./elevation');

const SETTINGS_FILE = 'benchwise-settings.json';
const LEGACY_SETTINGS_FILE = 'qudit-settings.json'; // Benchwise was called Qudit before 2.1

const TEST_IDS = ['mdm', 'camera', 'microphone', 'speakers', 'keyboard', 'display', 'touchscreen', 'ports', 'drives', 'cpu', 'memory'];

const DEFAULTS = Object.freeze({
  stationName: '',
  defaultTechnician: '',
  assetTagLabel: 'Asset Tag',
  // Regex (without ^ $) the asset tag must match. Empty = any safe tag.
  // The original Qudit 1.x format was: \d{7}-\d{7}
  assetTagPattern: '',
  reportsDir: '', // empty = <data dir>/reports
  // MDM / Autopilot test. KnownTenants.txt is client data: it lives on the
  // intake share or the stick, never in the app. Empty = <data dir>/KnownTenants.txt.
  knownTenantsFile: '',
  // Site policy: does a locked unit fail the audit? (Some sites only record it.)
  mdmLockedFails: true,
  enabledTests: TEST_IDS.reduce((acc, id) => ({ ...acc, [id]: true }), {}),
});

/**
 * Where settings and reports live, in priority order:
 *  1. BENCHWISE_DATA_DIR env var (QUDIT_DATA_DIR still accepted)
 *  2. Portable mode: a "benchwise-data" folder next to the executable (created
 *     by the user, or automatically for the Windows portable build). This is
 *     what makes running from a USB stick keep everything on the stick. A
 *     "qudit-data" folder from before the rename is renamed in place.
 *  3. The OS per-user app data folder. Settings and reports from the old
 *     "Qudit" folder are moved over on first launch.
 */
function resolveDataDir(app) {
  const fromEnv = process.env.BENCHWISE_DATA_DIR || process.env.QUDIT_DATA_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
  const portable = path.join(exeDir, 'benchwise-data');
  const legacyPortable = path.join(exeDir, 'qudit-data');
  if (!fs.existsSync(portable) && fs.existsSync(legacyPortable)) {
    try {
      fs.renameSync(legacyPortable, portable);
    } catch {
      return legacyPortable; // read-only stick etc.: keep using the old folder
    }
  }
  if (process.env.PORTABLE_EXECUTABLE_DIR || fs.existsSync(portable)) return portable;
  const userData = app.getPath('userData');
  migrateLegacyUserData(path.join(app.getPath('appData'), 'Qudit'), userData);
  return userData;
}

/** One-time move of settings + reports from the pre-rename "Qudit" app folder. */
function migrateLegacyUserData(legacyDir, dataDir) {
  try {
    const legacySettings = path.join(legacyDir, LEGACY_SETTINGS_FILE);
    if (!fs.existsSync(legacySettings) || fs.existsSync(path.join(dataDir, SETTINGS_FILE))) return;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(legacySettings, path.join(dataDir, SETTINGS_FILE));
    const legacyReports = path.join(legacyDir, 'reports');
    const reports = path.join(dataDir, 'reports');
    if (fs.existsSync(legacyReports) && !fs.existsSync(reports)) fs.renameSync(legacyReports, reports);
  } catch {
    /* best effort: worst case the operator re-enters settings */
  }
}

class Settings {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, SETTINGS_FILE);
    this.values = this.#load();
  }

  #load() {
    try {
      const legacy = path.join(this.dataDir, LEGACY_SETTINGS_FILE);
      const file = !fs.existsSync(this.file) && fs.existsSync(legacy) ? legacy : this.file;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return sanitize({ ...DEFAULTS, ...parsed, enabledTests: { ...DEFAULTS.enabledTests, ...parsed.enabledTests } });
    } catch {
      return sanitize({ ...DEFAULTS });
    }
  }

  get() {
    return { ...this.values, effectiveReportsDir: this.reportsDir(), dataDir: this.dataDir };
  }

  update(partial) {
    const next = sanitize({
      ...this.values,
      ...partial,
      enabledTests: { ...this.values.enabledTests, ...(partial?.enabledTests || {}) },
    });
    if (next.assetTagPattern) new RegExp(next.assetTagPattern); // throws on invalid pattern
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2));
    giveToOwner(this.dataDir, this.file); // elevated on Linux: keep files the operator's
    this.values = next;
    return this.get();
  }

  reportsDir() {
    return this.values.reportsDir ? path.resolve(this.values.reportsDir) : path.join(this.dataDir, 'reports');
  }
}

function sanitize(v) {
  const str = (x, max = 200) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
  const enabledTests = {};
  for (const id of TEST_IDS) enabledTests[id] = v.enabledTests?.[id] !== false;
  return {
    stationName: str(v.stationName, 80),
    defaultTechnician: str(v.defaultTechnician, 80),
    assetTagLabel: str(v.assetTagLabel, 40) || DEFAULTS.assetTagLabel,
    assetTagPattern: str(v.assetTagPattern, 200),
    reportsDir: str(v.reportsDir, 1024),
    knownTenantsFile: str(v.knownTenantsFile, 1024),
    mdmLockedFails: v.mdmLockedFails !== false,
    enabledTests,
  };
}

module.exports = { Settings, resolveDataDir, migrateLegacyUserData, TEST_IDS, DEFAULTS };
