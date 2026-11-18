'use strict';

// Where is Benchwise running? Some checks are only meaningful in one place:
// the MDM / Autopilot check, for example, only gives a trustworthy answer
// during Windows setup (OOBE), when Windows downloads its Autopilot profile.
//
//   oobe     Windows setup screens (opened with Shift+F10)
//   audit    Windows audit mode (Ctrl+Shift+F3 at setup)
//   winpe    Windows PE
//   windows  a normal, set-up Windows
//   live     a Linux live USB
//   linux    an installed Linux
//   macos
//
// The raw values are kept in `evidence`, so the detection can be checked
// against real machines from saved reports.

const fs = require('node:fs/promises');
const os = require('node:os');
const { readKey } = require('./registry');

/** Pure: Windows registry values -> mode. */
function classifyWindows({ setup, status, miniNt }) {
  if (miniNt) return 'winpe';
  if (status?.AuditBoot === 1) return 'audit';
  if (setup?.OOBEInProgress === 1 || setup?.SystemSetupInProgress === 1) return 'oobe';
  return 'windows';
}

/** Pure: Linux kernel command line -> live USB or installed. */
function classifyLinux(cmdline = '') {
  return /\bboot=(live|casper)\b|\brd\.live\.image\b|\blivecd\b/.test(cmdline) ? 'live' : 'linux';
}

const MODES = ['oobe', 'audit', 'winpe', 'windows', 'live', 'linux', 'macos'];

/** Detects the environment; BENCHWISE_ENV_MODE overrides it (testing, VMs). */
async function detectEnvironment(opts = {}) {
  const env = await detectRaw(opts);
  const forced = (opts.envVars || process.env).BENCHWISE_ENV_MODE;
  if (MODES.includes(forced)) return { ...env, mode: forced, detectedMode: env.mode, source: 'override' };
  return env;
}

async function detectRaw({ platform = process.platform, read = readKey, readFile = fs.readFile, user = () => os.userInfo().username } = {}) {
  let username = null;
  try {
    username = user();
  } catch {
    /* no user (some service contexts) */
  }

  if (platform === 'win32') {
    const [setup, status, miniNt] = await Promise.all([
      read('HKLM\\SYSTEM\\Setup'),
      read('HKLM\\SYSTEM\\Setup\\Status'),
      read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\MiniNT'),
    ]);
    const pick = (o, keys) => (o ? Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]])) : null);
    return {
      mode: classifyWindows({ setup, status, miniNt }),
      evidence: {
        setup: pick(setup, ['OOBEInProgress', 'SystemSetupInProgress', 'SetupType', 'SetupPhase', 'SetupShutdownRequired']),
        status: pick(status, ['AuditBoot', 'ChildCompletion']),
        miniNt: Boolean(miniNt),
        username,
      },
    };
  }
  if (platform === 'linux') {
    const cmdline = await readFile('/proc/cmdline', 'utf8').catch(() => '');
    return { mode: classifyLinux(cmdline), evidence: { cmdline: cmdline.trim().slice(0, 300), username } };
  }
  return { mode: platform === 'darwin' ? 'macos' : platform, evidence: { username } };
}

module.exports = { detectEnvironment, classifyWindows, classifyLinux };
