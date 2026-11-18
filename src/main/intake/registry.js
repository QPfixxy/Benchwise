'use strict';

// Reads the Windows registry with reg.exe (built into every Windows, no
// PowerShell start-up cost, which was ~9 s per start on some HP images).

const { execFile } = require('node:child_process');

/**
 * Parses `reg query <key>` output into { name: value }. DWORD/QWORD values
 * become numbers; everything else stays a string. The default value is "".
 */
function parseRegQuery(text = '') {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    // "    Name    REG_TYPE    data": fields are separated by 4 spaces;
    // names may contain single spaces, and data may be empty.
    const m = /^ {4}(.+?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/.exec(line);
    if (!m) continue;
    const [, rawName, type, data = ''] = m;
    const name = rawName === '(Default)' ? '' : rawName;
    if (type === 'REG_DWORD' || type === 'REG_QWORD') {
      const n = Number.parseInt(data, 16);
      values[name] = Number.isFinite(n) ? n : null;
    } else {
      values[name] = data.trim();
    }
  }
  return values;
}

/**
 * All values of one key, or null if the key doesn't exist (or reg.exe isn't
 * available). Never throws.
 */
function readKey(key, { exec = execFile, timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    // /reg:64: always the 64-bit view, so WOW64 redirection can never hide a key.
    exec('reg', ['query', key, '/reg:64'], { timeout, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(parseRegQuery(stdout));
    });
  });
}

module.exports = { parseRegQuery, readKey };
