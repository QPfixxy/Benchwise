#!/usr/bin/env node
'use strict';

// Root-only helper: applies the network and certificate choices made in the
// setup wizard. Started by systemd (benchwise-server-apply.path) when the
// web service drops a request in its inbox. The web service runs sandboxed
// and unprivileged; this is the only way its choices reach root-owned files.
//
// Trust nothing in the request:
//  - read without following links, size-limited, re-validated with the same
//    checks as the wizard (only this machine's addresses; a certificate and
//    key that parse and belong together);
//  - output only to fixed paths; no command, path or template comes from it;
//  - if nginx rejects the result, the previous files are put back.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { checkNetwork, checkCertificate, localInterfaces } = require('./setup');

const DEFAULT_PATHS = {
  inbox: '/var/lib/benchwise-server/requests/apply.json',
  status: '/var/lib/benchwise-server/apply-status.json',
  etc: '/etc/benchwise-server',
  templates: '/opt/benchwise-server/deploy',
  nginxSite: '/etc/nginx/sites-available/benchwise-server',
  sysctl: '/etc/sysctl.d/90-benchwise-no-forwarding.conf',
};

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

/**
 * Applies one request. Pure apart from the files under `paths` and the
 * commands run through `run`, so it can be tested in a temporary folder.
 */
function applyRequest(req, { paths = DEFAULT_PATHS, interfaces = localInterfaces(), run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' }) } = {}) {
  const net = req?.network;
  const netErrors = checkNetwork(net, interfaces);
  const cert = checkCertificate(req?.certificate);
  const errors = [...netErrors, ...cert.errors];
  if (errors.length) throw new Error(errors.join(' '));

  const crt = path.join(paths.etc, 'tls', 'server.crt');
  const key = path.join(paths.etc, 'tls', 'server.key');
  const env = path.join(paths.etc, 'server.env');
  const conf = path.join(paths.etc, 'install.conf');
  const before = { site: readIf(paths.nginxSite), crt: readIf(crt), key: readIf(key), env: readIf(env), conf: readIf(conf), sysctl: readIf(paths.sysctl) };

  try {
    // nginx: one template or the other, addresses validated above.
    if (net.mode === 'two') {
      const tpl = fs.readFileSync(path.join(paths.templates, 'nginx-two-networks.conf'), 'utf8');
      fs.writeFileSync(paths.nginxSite, tpl.replaceAll('__COMPANY_IP__', net.companyIp).replaceAll('__FLOOR_IP__', net.floorIp), { mode: 0o644 });
      fs.writeFileSync(paths.sysctl, 'net.ipv4.ip_forward = 0\nnet.ipv6.conf.all.forwarding = 0\n', { mode: 0o644 });
    } else {
      fs.copyFileSync(path.join(paths.templates, 'nginx.conf'), paths.nginxSite);
      fs.rmSync(paths.sysctl, { force: true });
    }

    // The service's settings: floor listener on or off.
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
  // Restart, not reload: the listening addresses may have changed.
  run('systemctl', ['restart', 'benchwise-server']);
  run('systemctl', ['restart', 'nginx']);
  return { ok: true, url: `https://${net.mode === 'two' ? net.companyIp : interfaces[0]?.address || 'this-server'}/` };
}

function writeStatus(file, status) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...status, at: new Date().toISOString() }), { mode: 0o644 });
  fs.renameSync(tmp, file);
}

function main() {
  const paths = DEFAULT_PATHS;
  if (!fs.existsSync(paths.inbox)) return;
  let req = null;
  try {
    req = readRequest(paths.inbox);
    writeStatus(paths.status, { id: req.id, state: 'applying' });
    const result = applyRequest(req, { paths });
    writeStatus(paths.status, { id: req.id, state: 'done', ...result });
  } catch (err) {
    writeStatus(paths.status, { id: req?.id || null, state: 'failed', message: err.message });
    process.exitCode = 1;
  } finally {
    fs.rmSync(paths.inbox, { force: true });
  }
}

if (require.main === module) main();

module.exports = { applyRequest, readRequest, DEFAULT_PATHS };
