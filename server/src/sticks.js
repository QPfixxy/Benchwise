'use strict';

// USB stick making at the site server (web-service side). Finds the drives
// plugged into the server, keeps the approved Benchwise build, and prepares
// the files a stick gets. Formatting and writing a drive needs root: that's
// done by the apply helper (apply.js), which re-checks the drive itself.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const yauzl = require('yauzl');

const GB = 1e9;
const MIN_SIZE = 1 * GB; // Benchwise unpacked is ~0.4 GB
const MAX_SIZE = 2048 * GB; // above this it's not a USB stick
const SYSTEM_MOUNTS = new Set(['/', '/boot', '/boot/efi', '/usr', '/var', '/home', '/opt', '/srv', '/tmp', '[SWAP]']);

// ---------------------------------------------------------------- drives

const LSBLK_ARGS = ['-J', '-b', '-o', 'NAME,PATH,SIZE,MODEL,VENDOR,SERIAL,TRAN,RM,HOTPLUG,TYPE,MOUNTPOINTS,FSTYPE,LABEL'];

function mountsOf(dev) {
  const own = (dev.mountpoints || []).filter(Boolean);
  return [...own, ...(dev.children || []).flatMap(mountsOf)];
}

/**
 * Pure: `lsblk -J` output -> drives that may be made into a stick.
 * A drive qualifies only if it's a whole disk on USB / removable / hot-plug,
 * a sensible size, and holds no system filesystem.
 */
function eligibleDrives(lsblk) {
  const out = [];
  for (const d of lsblk?.blockdevices || []) {
    if (d.type !== 'disk') continue; // no loop, rom, partitions
    const removable = d.tran === 'usb' || d.rm === true || d.rm === '1' || d.hotplug === true || d.hotplug === '1';
    const size = Number(d.size) || 0;
    const mounts = mountsOf(d);
    const system = mounts.some((m) => SYSTEM_MOUNTS.has(m));
    const why = !removable ? 'not a removable/USB drive' : system ? 'holds a system filesystem' : size < MIN_SIZE ? 'smaller than 1 GB' : size > MAX_SIZE ? 'too large for a stick' : null;
    out.push({
      name: d.name,
      path: d.path || `/dev/${d.name}`,
      sizeBytes: size,
      size: size >= 1e12 ? `${(size / 1e12).toFixed(1)} TB` : `${(size / GB).toFixed(1)} GB`,
      model: [d.vendor, d.model].map((x) => (x || '').trim()).filter(Boolean).join(' ') || 'USB drive',
      serial: (d.serial || '').trim() || null,
      label: (d.children || []).map((c) => c.label).find(Boolean) || d.label || null,
      mounted: mounts,
      eligible: !why,
      why,
    });
  }
  return out;
}

function listDrives({ exec = execFile } = {}) {
  return new Promise((resolve) => {
    exec('lsblk', LSBLK_ARGS, { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        // Removable drives only (eligible or with the reason they aren't); internal disks are never listed.
        resolve(eligibleDrives(JSON.parse(stdout)).filter((d) => d.why !== 'not a removable/USB drive'));
      } catch {
        resolve([]);
      }
    });
  });
}

// ---------------------------------------------------------------- the Benchwise build

// Builds before this can't send reports to a server (no outbox), so sticks
// never get them.
const MIN_STICK_VERSION = '2.5.0-beta.2';

/** Semantic-version compare ("2.5.0-beta.2" < "2.5.0" < "2.5.1"). null if unparsable. */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
    return m && { core: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] };
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1; // a release beats its pre-releases
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) return +p < +q ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Throws unless `version` is a build sticks may carry. */
function checkStickVersion(version) {
  const c = compareVersions(version, MIN_STICK_VERSION);
  if (c === null) throw new Error(`Can't tell which Benchwise version this is ("${version || 'unknown'}"). Use the "Benchwise-<version>-win-x64.zip" file from a release, without renaming it.`);
  if (c < 0) throw new Error(`Benchwise ${version} can't send reports to a server. Sticks need Benchwise ${MIN_STICK_VERSION} or later.`);
}

/** The version in a release file name ("Benchwise-2.5.0-beta.2-win-x64.zip"), or null. */
const versionFromFileName = (name) => (/^Benchwise-(.+)-win-x64\.zip$/.exec(String(name || '')) || [])[1] || null;

/** Reads a ZIP's file list and checks it's a Benchwise stick build. */
function inspectZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(new Error(`Not a valid ZIP file (${err.message}).`));
      const names = [];
      let total = 0;
      zip.on('entry', (e) => {
        // Zip-slip: no absolute paths, no "..", no drive letters.
        if (/^[/\\]|^[A-Za-z]:|(^|[/\\])\.\.([/\\]|$)/.test(e.fileName)) {
          zip.close();
          return reject(new Error(`Unsafe path in ZIP: ${e.fileName}`));
        }
        names.push(e.fileName);
        total += e.uncompressedSize;
        zip.readEntry();
      });
      zip.on('end', () => {
        const top = new Set(names.map((n) => n.toLowerCase()));
        const missing = ['benchwise.exe', 'launch.cmd'].filter((n) => !top.has(n));
        if (missing.length) return reject(new Error(`This isn't a Benchwise stick build (missing ${missing.join(', ')} at the top level). Use the "-win-x64.zip" file from a Benchwise release.`));
        if (total > 2 * GB) return reject(new Error('The ZIP unpacks to more than 2 GB.'));
        resolve({ files: names.length, unpackedBytes: total });
      });
      // yauzl itself refuses "../" and absolute names: say so plainly.
      zip.on('error', (e) => reject(/relative path|absolute path/.test(e.message) ? new Error(`Unsafe path in ZIP: ${e.message.replace(/^.*?path:\s*/, '')}`) : new Error(`Not a valid ZIP file (${e.message}).`)));
      zip.readEntry();
    });
  });
}

const sha256File = async (file) => {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
};

/**
 * Downloads the newest Benchwise release's stick build from GitHub, checking
 * the SHA-256 GitHub publishes for the file. `fetchImpl` is injectable.
 */
async function fetchRelease({ repo = 'QPfixxy/Benchwise', includePrerelease = false, dest, fetchImpl = fetch }) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=15`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'benchwise-server' } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
  const releases = (await res.json()).filter((r) => !r.draft && (includePrerelease || !r.prerelease));
  let tooOld = null;
  for (const r of releases) {
    const asset = (r.assets || []).find((a) => /^Benchwise-.+-win-x64\.zip$/.test(a.name));
    if (!asset) continue;
    const version = r.tag_name.replace(/^v/, '');
    if ((compareVersions(version, MIN_STICK_VERSION) ?? -1) < 0) {
      tooOld ??= version;
      continue;
    }
    const dl = await fetchImpl(asset.browser_download_url, { headers: { 'user-agent': 'benchwise-server' } });
    if (!dl.ok) throw new Error(`Download failed (${dl.status}).`);
    const tmp = `${dest}.download`;
    await fsp.writeFile(tmp, Buffer.from(await dl.arrayBuffer()));
    const sha = await sha256File(tmp);
    const expected = String(asset.digest || '').replace(/^sha256:/, '');
    if (expected && expected !== sha) {
      await fsp.rm(tmp, { force: true });
      throw new Error(`Checksum mismatch for ${asset.name}: the download is corrupt or was tampered with.`);
    }
    await inspectZip(tmp);
    await fsp.rename(tmp, dest);
    return { version, file: asset.name, sha256: sha, verified: Boolean(expected), prerelease: Boolean(r.prerelease), source: 'github' };
  }
  if (tooOld) throw new Error(`The newest ${includePrerelease ? 'release' : 'full release'} with a stick build is ${tooOld}, which can't send reports to a server. Sticks need ${MIN_STICK_VERSION} or later${includePrerelease ? '' : '; try including pre-releases'}.`);
  throw new Error(`No release of ${repo} has a Windows stick build (…-win-x64.zip)${includePrerelease ? '' : '; try including pre-releases'}.`);
}

// ---------------------------------------------------------------- what goes on a stick

// Characters that would break or inject into a Windows batch file.
const CMD_UNSAFE = /[%!"^&<>|\r\n]/;

/** site.cmd for a stick: the launcher `call`s it. CRLF, batch-safe values only. */
function buildSiteCmd({ serverUrl, key, fingerprint, wifiName, checkHost }) {
  for (const [label, v] of Object.entries({ serverUrl, key, fingerprint, wifiName, checkHost })) {
    if (v && CMD_UNSAFE.test(String(v))) throw new Error(`${label} contains a character that can't go in a batch file.`);
  }
  const lines = [
    '@echo off',
    'rem Made by Benchwise Server: site settings for this stick.',
    'rem The station key below identifies this stick: keep the stick safe;',
    'rem a lost stick can be revoked in the server\'s Administration page.',
    wifiName ? `set "WIFI_NAME=${wifiName}"` : 'rem No floor Wi-Fi set: the stick needs a wired connection.',
    // The launcher pings this to see whether there's internet (the MDM check needs it).
    `set "CHECK_HOST=${checkHost || '8.8.8.8'}"`,
    `set "BENCHWISE_SERVER_URL=${serverUrl}"`,
    `set "BENCHWISE_SERVER_KEY=${key}"`,
    fingerprint ? `set "BENCHWISE_SERVER_FINGERPRINT=${fingerprint}"` : 'rem The server uses a company certificate: no fingerprint needed.',
  ];
  return `${lines.join('\r\n')}\r\n`;
}

function buildReadme({ site, stationName, server, version, madeAt }) {
  return [
    `Benchwise USB stick - ${site}`,
    '',
    'In Windows setup (OOBE): press Shift+F10, then run  X:\\Benchwise\\LAUNCH',
    "(X is this stick's drive letter). Reports are kept on this stick and sent",
    'to the Benchwise server when it can be reached.',
    '',
    `Station:   ${stationName}`,
    `Server:    ${server}`,
    `Benchwise: ${version}`,
    `Made:      ${madeAt}`,
    '',
  ].join('\r\n');
}

module.exports = { MIN_STICK_VERSION, compareVersions, checkStickVersion, versionFromFileName, eligibleDrives, listDrives, inspectZip, fetchRelease, sha256File, buildSiteCmd, buildReadme, CMD_UNSAFE, LSBLK_ARGS, MIN_SIZE, SYSTEM_MOUNTS };
