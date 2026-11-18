#!/usr/bin/env node
'use strict';

// Root-only helper for the things the (sandboxed, unprivileged) web service
// may ask for but can't do itself:
//   setup  apply the wizard's network and certificate choices
//   stick  erase a USB drive plugged into the server and make it a Benchwise stick
//
// Started by systemd (benchwise-server-apply.path) when the web service drops
// a request in its inbox. Trust nothing in a request:
//  - read without following links, size-limited, and fully re-validated;
//  - outputs only to fixed paths; commands and their arguments are built here,
//    from validated values only, never taken from the request;
//  - a failed setup puts the previous files back; a failed stick is unmounted.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { checkNetwork, checkCertificate, localInterfaces } = require('./setup');
const { eligibleDrives, LSBLK_ARGS } = require('./sticks');

const DEFAULT_PATHS = {
  inbox: '/var/lib/benchwise-server/requests',
  status: '/var/lib/benchwise-server/status',
  sticks: '/var/lib/benchwise-server/sticks',
  etc: '/etc/benchwise-server',
  templates: '/opt/benchwise-server/deploy',
  nginxSite: '/etc/nginx/sites-available/benchwise-server',
  sysctl: '/etc/sysctl.d/90-benchwise-no-forwarding.conf',
  mountBase: '/run',
};

const defaultRun = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], input: opts.input, encoding: 'utf8', timeout: opts.timeout || 600000 });

function readRequest(file) {
  // O_NOFOLLOW: a link planted in the inbox can't make root read another file.
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 256 * 1024) throw new Error('Request file is not a regular file of sensible size.');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

const readIf = (f) => (fs.existsSync(f) ? fs.readFileSync(f) : null);
function restore(f, content, mode) {
  if (content === null) fs.rmSync(f, { force: true });
  else fs.writeFileSync(f, content, { mode });
}

// ---------------------------------------------------------------- setup: network + certificate

function applyRequest(req, { paths = DEFAULT_PATHS, interfaces = localInterfaces(), run = defaultRun } = {}) {
  const net = req?.network;
  const errors = [...checkNetwork(net, interfaces), ...checkCertificate(req?.certificate).errors];
  if (errors.length) throw new Error(errors.join(' '));

  const crt = path.join(paths.etc, 'tls', 'server.crt');
  const key = path.join(paths.etc, 'tls', 'server.key');
  const env = path.join(paths.etc, 'server.env');
  const conf = path.join(paths.etc, 'install.conf');
  const before = { site: readIf(paths.nginxSite), crt: readIf(crt), key: readIf(key), env: readIf(env), conf: readIf(conf), sysctl: readIf(paths.sysctl) };

  try {
    if (net.mode === 'two') {
      const tpl = fs.readFileSync(path.join(paths.templates, 'nginx-two-networks.conf'), 'utf8');
      fs.writeFileSync(paths.nginxSite, tpl.replaceAll('__COMPANY_IP__', net.companyIp).replaceAll('__FLOOR_IP__', net.floorIp), { mode: 0o644 });
      fs.writeFileSync(paths.sysctl, 'net.ipv4.ip_forward = 0\nnet.ipv6.conf.all.forwarding = 0\n', { mode: 0o644 });
    } else {
      fs.copyFileSync(path.join(paths.templates, 'nginx.conf'), paths.nginxSite);
      fs.rmSync(paths.sysctl, { force: true });
    }
    const lines = String(before.env || '').split('\n').filter((l) => l && !l.startsWith('BW_FLOOR_LISTEN='));
    if (net.mode === 'two') lines.push('BW_FLOOR_LISTEN=127.0.0.1:8081');
    fs.writeFileSync(env, `${lines.join('\n')}\n`, { mode: 0o640 });
    fs.writeFileSync(conf, `COMPANY_IP="${net.mode === 'two' ? net.companyIp : ''}"\nFLOOR_IP="${net.mode === 'two' ? net.floorIp : ''}"\n`, { mode: 0o600 });
    if (req.certificate?.mode === 'upload') {
      fs.mkdirSync(path.dirname(crt), { recursive: true });
      fs.writeFileSync(crt, req.certificate.certPem, { mode: 0o644 });
      fs.writeFileSync(key, req.certificate.keyPem, { mode: 0o600 });
    }
    run('nginx', ['-t', '-q']);
  } catch (err) {
    restore(paths.nginxSite, before.site, 0o644);
    restore(crt, before.crt, 0o644);
    restore(key, before.key, 0o600);
    restore(env, before.env, 0o640);
    restore(conf, before.conf, 0o600);
    restore(paths.sysctl, before.sysctl, 0o644);
    throw new Error(`Not applied, previous settings kept: ${err.stderr ? String(err.stderr).trim() : err.message}`);
  }
  if (net.mode === 'two') run('sysctl', ['-q', '--system']);
  run('systemctl', ['restart', 'benchwise-server']);
  run('systemctl', ['restart', 'nginx']);
  return { ok: true, url: `https://${net.mode === 'two' ? net.companyIp : interfaces[0]?.address || 'this-server'}/` };
}

// ---------------------------------------------------------------- stick: erase and write a USB drive

const DEVICE_NAME = /^(sd[a-z]{1,2}|nvme\d+n\d+|mmcblk\d+)$/;
const partitionOf = (dev) => (/\d$/.test(dev) ? `${dev}p1` : `${dev}1`);
/** Names of the programs keeping a mount busy, best effort ("nautilus (pid 9822)"). */
function holders(mountpoint, run) {
  let pids = [];
  try {
    pids = String(run('fuser', ['-m', mountpoint])).trim().split(/\s+/).filter((p) => /^\d+$/.test(p));
  } catch (err) {
    pids = String(err.stdout || '').trim().split(/\s+/).filter((p) => /^\d+$/.test(p));
  }
  return pids
    .map((pid) => {
      try {
        return `${fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim()} (pid ${pid})`;
      } catch {
        return `pid ${pid}`;
      }
    })
    .join(', ');
}
const textFile = (v, max) => typeof v === 'string' && v.length <= max && !v.includes('\0');

/**
 * Makes one stick. `progress(step)` reports each stage. The drive is checked
 * again here (it must still be a removable, non-system disk, and the same
 * physical drive the admin chose).
 */
function makeStick(req, { paths = DEFAULT_PATHS, run = defaultRun, progress = () => {} } = {}) {
  if (!DEVICE_NAME.test(req?.device || '')) throw new Error('Not a drive name this server makes sticks on.');
  for (const [k, max] of [['siteCmd', 8192], ['readme', 8192]]) if (!textFile(req[k], max)) throw new Error(`Missing or oversized ${k}.`);
  if (req.wifiXml !== null && req.wifiXml !== undefined && !textFile(req.wifiXml, 16384)) throw new Error('Oversized wifiXml.');
  const app = path.join(paths.sticks, 'app.zip');
  if (!fs.existsSync(app)) throw new Error('No Benchwise build for sticks on this server yet.');

  const drive = eligibleDrives(JSON.parse(run('lsblk', LSBLK_ARGS))).find((d) => d.name === req.device);
  if (!drive) throw new Error(`/dev/${req.device} is no longer plugged in.`);
  if (!drive.eligible) throw new Error(`/dev/${req.device} can't be used: ${drive.why}.`);
  if (req.serial && drive.serial !== req.serial) throw new Error('A different drive is now in that slot; nothing was erased.');

  const dev = `/dev/${req.device}`;
  const part = `/dev/${partitionOf(req.device)}`;
  const mnt = path.join(paths.mountBase, `benchwise-stick-${process.pid}-${Date.now()}`);
  let mounted = false;
  try {
    progress('Preparing the drive');
    // Unmount everything before anything is erased. A drive another program
    // still has open (say a desktop file manager window) is refused, naming
    // the program: a lazy unmount would leave the disk in use, and writing
    // under an open filesystem isn't safe.
    for (const m of drive.mounted) {
      try {
        run('umount', [m]);
      } catch {
        throw new Error(`The drive is open in another program (${holders(m, run) || 'unknown'}); close it, then try again. Nothing was erased.`);
      }
    }
    run('wipefs', ['--all', '--force', dev]);
    progress('Formatting (exFAT)');
    // One partition, the whole drive, type 7 (exFAT/NTFS), bootable flag off.
    run('sfdisk', ['--quiet', '--wipe', 'always', dev], { input: 'label: dos\n,,7\n' });
    run('udevadm', ['settle']);
    run('mkfs.exfat', ['-L', 'BENCHWISE', part]);
    fs.mkdirSync(mnt, { mode: 0o700 });
    run('mount', ['-t', 'exfat', part, mnt]);
    mounted = true;
    progress('Copying Benchwise');
    fs.mkdirSync(path.join(mnt, 'Benchwise'));
    run('unzip', ['-q', '-o', app, '-d', path.join(mnt, 'Benchwise')]);
    progress('Writing the settings');
    fs.writeFileSync(path.join(mnt, 'Benchwise', 'site.cmd'), req.siteCmd);
    if (req.wifiXml) fs.writeFileSync(path.join(mnt, 'Benchwise', 'wifi.xml'), req.wifiXml);
    fs.writeFileSync(path.join(mnt, 'README.TXT'), req.readme);
    progress('Finishing');
    run('sync', []);
    run('umount', [mnt]);
    mounted = false;
    return { ok: true, drive: `${drive.model} (${drive.size})` };
  } finally {
    if (mounted) {
      try {
        run('umount', [mnt]);
      } catch {
        /* best effort */
      }
    }
    fs.rmSync(mnt, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the inbox

function writeStatus(dir, id, status) {
  if (!/^[0-9a-f-]{36}$/.test(id || '')) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ id, ...status, at: new Date().toISOString() }), { mode: 0o644 });
  fs.renameSync(`${file}.tmp`, file);
}

function processInbox({ paths = DEFAULT_PATHS, run = defaultRun, interfaces } = {}) {
  let files = [];
  try {
    files = fs.readdirSync(paths.inbox).filter((f) => /^[\w-]+\.json$/.test(f)).sort();
  } catch {
    return;
  }
  for (const f of files) {
    const file = path.join(paths.inbox, f);
    let req = null;
    try {
      req = readRequest(file);
      const say = (step) => writeStatus(paths.status, req.id, { type: req.type, state: 'working', step });
      say('Starting');
      const result = req.type === 'stick' ? makeStick(req, { paths, run, progress: say }) : applyRequest(req, { paths, run, interfaces: interfaces || localInterfaces() });
      writeStatus(paths.status, req.id, { type: req.type, state: 'done', ...result });
    } catch (err) {
      writeStatus(paths.status, req?.id, { type: req?.type || null, state: 'failed', message: err.stderr && !err.message.includes(String(err.stderr).trim()) ? `${err.message}: ${String(err.stderr).trim()}` : err.message });
      process.exitCode = 1;
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
}

if (require.main === module) processInbox();

module.exports = { applyRequest, makeStick, readRequest, processInbox, writeStatus, partitionOf, DEFAULT_PATHS };
