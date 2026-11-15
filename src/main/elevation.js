'use strict';

// Administrator / root handling.
//
//  Windows  The packaged .exe carries a requireAdministrator manifest, so
//           Windows shows the UAC prompt on every launch. Nothing to do here
//           except report whether we got it.
//  Linux    No manifest equivalent. The packaged app asks once, then relaunches
//           itself through pkexec (the desktop's password prompt). If the
//           operator declines, Benchwise runs in limited mode. On a live USB that
//           starts Benchwise as root, nothing is asked.
//  macOS    Not needed: drive health and inventory work without root.
//
// Why: firmware serials, memory-module details (DMI) and SMART data are
// only readable with admin rights on Windows and Linux.

const fs = require('node:fs');
const { spawn, execFile } = require('node:child_process');

let cached;

/** true / false, or null where the concept doesn't apply (macOS). */
async function isElevated() {
  if (cached !== undefined) return cached;
  if (process.platform === 'linux') cached = process.getuid?.() === 0;
  else if (process.platform === 'win32') {
    // `net session` only succeeds in an elevated process.
    cached = await new Promise((resolve) => execFile('net', ['session'], { windowsHide: true, timeout: 5000 }, (err) => resolve(!err)));
  } else cached = null;
  return cached;
}

/**
 * Linux only. Returns 'continue' (run this process, possibly limited) or
 * 'exit' (an elevated copy ran and has finished; this process should quit).
 */
async function ensureLinuxElevation({ app, dialog, dataDir }) {
  if (process.platform !== 'linux' || process.getuid?.() === 0) return 'continue';
  if (!app.isPackaged || process.env.BENCHWISE_NO_ELEVATE === '1' || process.argv.includes('--limited')) return 'continue';

  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'Benchwise',
    message: 'Run Benchwise as administrator?',
    detail:
      'Administrator access is needed to read the system serial number, memory module details and drive health (SMART). ' +
      'Without it, those fields will be missing from the report.',
    buttons: ['Continue as administrator', 'Run in limited mode'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return 'continue';

  // Relaunch the AppImage file itself (root can't read another user's FUSE
  // mount), extracting instead of mounting so FUSE isn't needed as root.
  const target = process.env.APPIMAGE || process.execPath;
  const pass = ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'LANG']
    .filter((k) => process.env[k])
    .map((k) => `${k}=${process.env[k]}`);
  const env = [
    ...pass,
    'APPIMAGE_EXTRACT_AND_RUN=1',
    `BENCHWISE_DATA_DIR=${dataDir}`, // keep settings/reports in the operator's folder…
    `BENCHWISE_OWNER_UID=${process.getuid()}`, // …and owned by the operator, not root
    `BENCHWISE_OWNER_GID=${process.getgid()}`,
  ];

  const code = await new Promise((resolve) => {
    const child = spawn('pkexec', ['env', ...env, target, '--no-sandbox'], { stdio: 'ignore' });
    child.on('error', () => resolve(-1)); // pkexec not installed
    child.on('exit', (c) => resolve(c ?? 0));
  });
  // 126 = authentication dismissed, 127 = not authorised, -1 = no pkexec
  if (code === 126 || code === 127 || code === -1) {
    await dialog.showMessageBox({
      type: 'warning',
      title: 'Benchwise',
      message: 'Running in limited mode',
      detail:
        code === -1
          ? 'pkexec is not available on this system. Start Benchwise with sudo for a complete report.'
          : 'Administrator access was not granted. Serials, memory details and drive health may be missing.',
    });
    return 'continue';
  }
  return 'exit';
}

/** When running elevated on behalf of a user, hand created files back to them. */
function giveToOwner(...paths) {
  const uid = Number(process.env.BENCHWISE_OWNER_UID);
  const gid = Number(process.env.BENCHWISE_OWNER_GID);
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || process.getuid?.() !== 0) return;
  for (const p of paths) {
    try {
      if (p) fs.chownSync(p, uid, gid);
    } catch {
      /* best effort (e.g. FAT-formatted network share) */
    }
  }
}

module.exports = { isElevated, ensureLinuxElevation, giveToOwner };
