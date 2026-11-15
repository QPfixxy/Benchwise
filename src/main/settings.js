'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { giveToOwner } = require('./elevation');

const SETTINGS_FILE = 'qudit-settings.json';

const TEST_IDS = ['camera', 'microphone', 'speakers', 'keyboard', 'display', 'touchscreen', 'ports', 'cpu', 'memory'];

const DEFAULTS = Object.freeze({
  stationName: '',
  defaultTechnician: '',
  assetTagLabel: 'Asset Tag',
  // Regex (without ^ $) the asset tag must match. Empty = any safe tag.
  // The original Qudit format was: \d{7}-\d{7}
  assetTagPattern: '',
  reportsDir: '', // empty = <data dir>/reports
  enabledTests: TEST_IDS.reduce((acc, id) => ({ ...acc, [id]: true }), {}),
});

/**
 * Where settings and reports live, in priority order:
 *  1. QUDIT_DATA_DIR env var
 *  2. Portable mode: a "qudit-data" folder next to the executable (created
 *     by the user, or automatically for the Windows portable build). This is
 *     what makes running from a USB stick keep everything on the stick.
 *  3. The OS per-user app data folder.
 */
function resolveDataDir(app) {
  if (process.env.QUDIT_DATA_DIR) return path.resolve(process.env.QUDIT_DATA_DIR);
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
  const portable = path.join(exeDir, 'qudit-data');
  if (process.env.PORTABLE_EXECUTABLE_DIR || fs.existsSync(portable)) return portable;
  return app.getPath('userData');
}

class Settings {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, SETTINGS_FILE);
    this.values = this.#load();
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
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
    enabledTests,
  };
}

module.exports = { Settings, resolveDataDir, TEST_IDS, DEFAULTS };
