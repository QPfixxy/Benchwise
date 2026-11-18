'use strict';

// Security inventory on Windows: TPM, Secure Boot and BitLocker on the
// system drive. Built-in Windows tools only (reg, tpmtool, manage-bde): no
// PowerShell, whose start-up took ~9 s per call on some HP images.
//
// Each piece is independent and never throws: a missing tool or an
// unexpected answer just leaves that field null.

const { execFile } = require('node:child_process');
const { readKey } = require('./registry');

function run(cmd, args, { exec = execFile, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    exec(cmd, args, { timeout, windowsHide: true, encoding: 'utf8' }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout || '')));
  });
}

/** "Key: value" lines (tpmtool prefixes them with "-"), indented or not. */
function parseColonList(text = '') {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*-?\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(line);
    if (m && m[2] !== '') out[m[1]] = m[2];
  }
  return out;
}

const yes = (v) => (v === undefined ? null : /^(true|yes)$/i.test(String(v).trim()));

/** Pure: `tpmtool getdeviceinformation` -> TPM summary. */
function parseTpmtool(text) {
  const kv = parseColonList(text);
  if (!('TPM Present' in kv)) return null;
  return {
    present: yes(kv['TPM Present']),
    version: kv['TPM Version'] || null,
    manufacturer: kv['TPM Manufacturer Full Name'] || kv['TPM Manufacturer ID'] || null,
    firmware: kv['TPM Manufacturer Version'] || null,
    ready: yes(kv['Ready For Storage']),
  };
}

/** Pure: `manage-bde -status C:` -> BitLocker summary for that volume. */
function parseManageBde(text) {
  const kv = parseColonList(text);
  if (!('Conversion Status' in kv)) return null;
  const pct = Number.parseFloat(String(kv['Percentage Encrypted'] || '').replace(',', '.'));
  return {
    conversion: kv['Conversion Status'],
    percentEncrypted: Number.isFinite(pct) ? pct : null,
    protection: kv['Protection Status'] || null,
    method: kv['Encryption Method'] || null,
    // "Fully Encrypted" / "Used Space Only Encrypted" / "Encryption in Progress"...
    encrypted: !/fully decrypted/i.test(kv['Conversion Status']),
  };
}

/** Pure: the SecureBoot\State registry key -> 'enabled' | 'disabled' | 'unsupported'. */
function secureBootState(stateKey) {
  if (!stateKey || !('UEFISecureBootEnabled' in stateKey)) return 'unsupported'; // legacy BIOS
  return stateKey.UEFISecureBootEnabled === 1 ? 'enabled' : 'disabled';
}

async function collectSecurity({ platform = process.platform, read = readKey, exec } = {}) {
  if (platform !== 'win32') return null;
  const systemDrive = process.env.SystemDrive || 'C:';
  const [sb, tpm, bde] = await Promise.all([
    read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\SecureBoot\\State'),
    run('tpmtool', ['getdeviceinformation'], { exec }),
    run('manage-bde', ['-status', systemDrive], { exec }),
  ]);
  return {
    secureBoot: secureBootState(sb),
    tpm: parseTpmtool(tpm),
    bitLocker: parseManageBde(bde),
  };
}

module.exports = { collectSecurity, parseTpmtool, parseManageBde, secureBootState };
