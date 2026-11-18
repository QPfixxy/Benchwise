'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { giveToOwner } = require('./elevation');

const SETTINGS_FILE = 'benchwise-settings.json';
const LEGACY_SETTINGS_FILE = 'qudit-settings.json'; // Benchwise was called Qudit before 2.1

const TEST_IDS = ['mdm', 'malware', 'camera', 'microphone', 'speakers', 'keyboard', 'display', 'touchscreen', 'ports', 'drives', 'cpu', 'memory'];

const DEFAULTS = Object.freeze({
  stationName: '',
  defaultTechnician: '',
  assetTagLabel: 'Asset Tag',
  // Regex (without ^ $) the asset tag must match. Empty = any safe tag.
  // The original Qudit 1.x format was: \d{7}-\d{7}
  assetTagPattern: '',
  // Off by default: records are keyed on the manufacturer serial.
  assetTagRequired: false,
  // Intake: save the report by itself when both checks have a verdict and
  // the report goes to the stick or a share.
  intakeAutoSave: true,
  // Benchwise Hub (central records). The stick's site.cmd can set these
  // instead: BENCHWISE_SERVER_URL, BENCHWISE_SERVER_KEY, BENCHWISE_SERVER_FINGERPRINT.
  serverUrl: '',
  serverKey: '',
  serverFingerprint: '',
  reportsDir: '', // empty = <data dir>/reports
  // MDM / Autopilot test. KnownTenants.txt is client data: it lives on the
  // intake share or the stick, never in the app. Empty = <data dir>/KnownTenants.txt.
  knownTenantsFile: '',
  // Site policy: does a locked unit fail the audit? (Some sites only record it.)
  mdmLockedFails: true,
  // Site policy: does malware fail the audit, or is it only recorded?
  malwareFails: false,
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
  // Started straight from a stick in Windows setup (not via the launcher):
  // keep the data on the stick. Windows setup's temporary account, where
  // userData would be, is deleted when setup finishes.
  if (process.platform === 'win32' && isSetupAccount() && offSystemDrive(exeDir)) {
    try {
      fs.mkdirSync(portable, { recursive: true });
      return portable;
    } catch {
      /* read-only: fall through; Benchwise warns before saving */
    }
  }
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
    // BENCHWISE_REPORTS_DIR: set by the stick launcher's site.cmd (e.g. the intake share).
    const dir = process.env.BENCHWISE_REPORTS_DIR || this.values.reportsDir;
    return dir ? path.resolve(dir) : path.join(this.dataDir, 'reports');
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
    assetTagRequired: v.assetTagRequired === true,
    intakeAutoSave: v.intakeAutoSave !== false,
    serverUrl: str(v.serverUrl, 300),
    serverKey: str(v.serverKey, 120),
    serverFingerprint: str(v.serverFingerprint, 140),
    reportsDir: str(v.reportsDir, 1024),
    knownTenantsFile: str(v.knownTenantsFile, 1024),
    mdmLockedFails: v.mdmLockedFails !== false,
    malwareFails: v.malwareFails === true,
    enabledTests,
  };
}

/** Windows' temporary setup (OOBE) account: defaultuser0, defaultuser100000... */
function isSetupAccount(user) {
  let name = user;
  if (name === undefined) {
    try {
      name = require('node:os').userInfo().username;
    } catch {
      name = '';
    }
  }
  return /^defaultuser\d+$/i.test(name || '');
}

/** True for a Windows path on a drive other than the system drive (e.g. a USB stick). */
function offSystemDrive(dir, systemDrive = process.env.SystemDrive || 'C:') {
  const m = /^([A-Za-z]:)/.exec(String(dir || ''));
  return Boolean(m) && m[1].toUpperCase() !== String(systemDrive).toUpperCase();
}

/**
 * Is the data folder on the stick Benchwise runs from? Either the launcher
 * said so, or the data folder sits next to the exe on a non-system drive and
 * can be written to.
 */
function detectStick({ dataDir, exeDir, envFlag = process.env.BENCHWISE_ON_STICK, platform = process.platform, canWrite = writable } = {}) {
  if (envFlag === '1') return true;
  if (platform !== 'win32' || !dataDir || !exeDir) return false;
  const p = path.win32; // Windows rules, whatever this code runs on (tests)
  const nextToExe = p.resolve(dataDir).toLowerCase() === p.resolve(exeDir, 'benchwise-data').toLowerCase();
  return nextToExe && offSystemDrive(exeDir) && canWrite(dataDir);
}

function writable(dir) {
  const probe = path.join(dir, `.write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where reports are going, for intake (Windows setup):
 *   share      a network path: survives anything
 *   stick      the launcher confirmed a writable USB stick holds the data folder
 *   temporary  Windows setup's temporary account: deleted when setup finishes
 *   local      this unit's own disk (an installed copy, or the read-only
 *              fallback): erased when the unit is wiped
 * Only share and stick are safe enough to auto-save to.
 */
function classifyStorage(reportsDir, { dataDir, onStick = false } = {}) {
  const dir = String(reportsDir || '');
  if (/^(\\\\|\/\/)[^\\/]+[\\/]/.test(dir)) return 'share';
  if (/[\\/]Users[\\/]defaultuser\d+[\\/]/i.test(dir)) return 'temporary';
  const inside = (child, parent) => {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  if (onStick && dataDir && inside(dir, dataDir)) return 'stick';
  return 'local';
}

/** The Hub to send reports to, or null if none is set up. site.cmd's values win. */
function serverConfig(values, env = process.env) {
  const url = (env.BENCHWISE_SERVER_URL || values.serverUrl || '').trim();
  const key = (env.BENCHWISE_SERVER_KEY || values.serverKey || '').trim();
  const fingerprint = (env.BENCHWISE_SERVER_FINGERPRINT || values.serverFingerprint || '').trim();
  if (!url || !key) return null;
  return { url, key, fingerprint: fingerprint || null, fromEnv: Boolean(env.BENCHWISE_SERVER_URL || env.BENCHWISE_SERVER_KEY) };
}

module.exports = { Settings, resolveDataDir, migrateLegacyUserData, classifyStorage, detectStick, offSystemDrive, isSetupAccount, serverConfig, TEST_IDS, DEFAULTS };
