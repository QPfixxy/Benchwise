#!/usr/bin/env node
'use strict';

// Puts a smartctl binary for this OS in vendor/smartctl/<target>/, where
// electron-builder bundles it (extraResources) and `npm start` finds it.
//
//   Windows  official smartmontools installer, run silently into a temp folder
//            (it picks the 64-bit build on 64-bit Windows)
//   macOS    built from the source release, arm64 + x86_64 merged (universal)
//   Linux    built from the source release, statically linked so the AppImage
//            works on any distro's glibc
//
// Downloads are pinned by SHA-256. smartmontools is GPL-2.0-or-later; its
// licence and the exact source tarball are shipped next to the binary.
//
// Usage: node scripts/vendor-smartctl.js [--force]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const VERSION = '7.5';
const BASE = `https://github.com/smartmontools/smartmontools/releases/download/RELEASE_${VERSION.replace('.', '_')}`;
const FILES = {
  source: { name: `smartmontools-${VERSION}.tar.gz`, sha256: '690b83ca331378da9ea0d9d61008c4b22dde391387b9bbad7f29387f2595f76e' },
  windows: { name: `smartmontools-${VERSION}.win32-setup.exe`, sha256: '896337fcc253220614cf8cdbd5cf2321c5aa326a37a04160a672a281e6104c70' },
};

const ROOT = path.join(__dirname, '..');
const target = process.platform === 'darwin' ? 'darwin-universal' : `${process.platform}-${process.arch}`;
const OUT = path.join(ROOT, 'vendor', 'smartctl', target);
const EXE = process.platform === 'win32' ? 'smartctl.exe' : 'smartctl';
const STAMP = path.join(OUT, 'VERSION');
const CACHE = path.join(ROOT, 'vendor', '.cache');

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const log = (msg) => console.log(`[vendor-smartctl] ${msg}`);

async function download({ name, sha256 }) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, name);
  const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  if (fs.existsSync(file) && hash(file) === sha256) return file;
  log(`downloading ${name}`);
  const res = await fetch(`${BASE}/${name}`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText} (${name})`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const got = hash(file);
  if (got !== sha256) {
    fs.rmSync(file);
    throw new Error(`checksum mismatch for ${name}: expected ${sha256}, got ${got}`);
  }
  return file;
}

function extractSource(tarball, into) {
  fs.mkdirSync(into, { recursive: true });
  // Extract by bare file name from inside the folder: some Windows tar builds
  // read a "C:" path as a remote host, and the repo and temp dir can be on
  // different drives.
  fs.copyFileSync(tarball, path.join(into, path.basename(tarball)));
  sh('tar', ['xzf', path.basename(tarball)], { cwd: into });
  return path.join(into, `smartmontools-${VERSION}`);
}

/** configure + make smartctl in a fresh copy of the source tree. */
function build(srcTarball, work, { configureArgs = [], env = {} }) {
  const dir = extractSource(srcTarball, work);
  const opts = { cwd: dir, env: { ...process.env, ...env } };
  sh('./configure', ['--quiet', '--without-libsystemd', '--without-selinux', '--without-libcap-ng', ...configureArgs], opts);
  sh('make', [`-j${os.availableParallelism?.() || 4}`, 'smartctl'], opts);
  return path.join(dir, 'smartctl');
}

async function main() {
  const force = process.argv.includes('--force');
  if (!force && fs.existsSync(STAMP) && fs.readFileSync(STAMP, 'utf8').trim() === VERSION && fs.existsSync(path.join(OUT, EXE))) {
    log(`smartctl ${VERSION} already in ${path.relative(ROOT, OUT)} (use --force to rebuild)`);
    return;
  }
  const tarball = await download(FILES.source);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'benchwise-smartctl-'));
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  try {
    if (process.platform === 'win32') {
      const installer = await download(FILES.windows);
      const dest = path.join(work, 'install');
      // NSIS: /S = silent, /D= must be last and unquoted.
      sh(installer, ['/S', `/D=${dest}`]);
      const exe = path.join(dest, 'bin', 'smartctl.exe');
      if (!fs.existsSync(exe)) throw new Error(`installer did not produce ${exe}`);
      fs.copyFileSync(exe, path.join(OUT, EXE));
    } else if (process.platform === 'darwin') {
      const flags = (arch) => `-O2 -arch ${arch} -mmacosx-version-min=11.0`;
      const native = process.arch === 'arm64' ? 'arm64' : 'x86_64';
      const triple = { arm64: 'aarch64-apple-darwin', x86_64: 'x86_64-apple-darwin' };
      const parts = [];
      for (const arch of ['arm64', 'x86_64']) {
        log(`building for ${arch}`);
        // The non-native slice is a cross build, so configure won't try to run it.
        const cross = arch === native ? [] : [`--build=${triple[native]}`, `--host=${triple[arch]}`];
        const bin = build(tarball, path.join(work, arch), {
          configureArgs: cross,
          env: { CXXFLAGS: flags(arch), CFLAGS: flags(arch), LDFLAGS: `-arch ${arch} -mmacosx-version-min=11.0` },
        });
        parts.push(bin);
      }
      sh('lipo', ['-create', ...parts, '-output', path.join(OUT, EXE)]);
      sh('lipo', ['-info', path.join(OUT, EXE)]);
    } else if (process.platform === 'linux') {
      log('building (static)');
      const bin = build(tarball, path.join(work, 'linux'), { env: { CXXFLAGS: '-O2', LDFLAGS: '-static' } });
      fs.copyFileSync(bin, path.join(OUT, EXE));
      sh('strip', [path.join(OUT, EXE)]);
      fs.chmodSync(path.join(OUT, EXE), 0o755);
    } else {
      throw new Error(`unsupported platform: ${process.platform}`);
    }

    // GPL: licence, plus the exact corresponding source.
    const src = extractSource(tarball, path.join(work, 'licence'));
    fs.copyFileSync(path.join(src, 'COPYING'), path.join(OUT, 'COPYING'));
    fs.copyFileSync(tarball, path.join(OUT, FILES.source.name));
    fs.writeFileSync(
      path.join(OUT, 'README.txt'),
      [
        `smartctl ${VERSION} from smartmontools (https://www.smartmontools.org/), GPL-2.0-or-later.`,
        'Benchwise runs it to read drive health (SMART) data. The licence is in COPYING and the',
        `unmodified source it was built from is ${FILES.source.name}`,
        `(${BASE}/${FILES.source.name}, sha256 ${FILES.source.sha256}).`,
        '',
      ].join('\n'),
    );

    if (process.platform !== 'win32') fs.chmodSync(path.join(OUT, EXE), 0o755);
    const out = execFileSync(path.join(OUT, EXE), ['--version'], { encoding: 'utf8' });
    const first = out.split('\n')[0];
    if (!first.includes(VERSION)) throw new Error(`unexpected smartctl --version output: ${first}`);
    log(first);
    fs.writeFileSync(STAMP, `${VERSION}\n`);
    log(`ready: ${path.relative(ROOT, OUT)}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[vendor-smartctl] FAILED: ${err.message}`);
  process.exit(1);
});
