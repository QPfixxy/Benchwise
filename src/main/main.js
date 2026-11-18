'use strict';

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, protocol, net, session, shell, dialog, systemPreferences, screen, utilityProcess } = require('electron');
const si = require('systeminformation');
const { StressManager } = require('./stress/manager');
const { TelemetrySampler, memInfo } = require('./stress/telemetry');
const { isElevated, ensureLinuxElevation } = require('./elevation');

const { collectHardware } = require('./hardware/collect');
const { checkDrives } = require('./drives/smartctl');
const { runMdmCheck, loadKnownTenants, mdmVerdict } = require('./intake/mdm');
const { runDefenderScan, malwareVerdict } = require('./intake/defender');
const { PortWatcher, listVolumes, prepareDrive, ejectVolume } = require('./ports/testdrive');
const { Settings, resolveDataDir, classifyStorage, detectStick } = require('./settings');
const { ReportStore, buildAudit } = require('./reports/store');
const { renderReportHtml } = require('./reports/template');

const RENDERER_ROOT = path.join(__dirname, '..', 'renderer');
const APP_ORIGIN = 'app://benchwise';
const smokeArgs = process.argv.filter((a) => a.startsWith('--smoke-test'));
const smokeArg = smokeArgs.find((a) => a.includes('=')) || smokeArgs[0];

// Electron's Chromium sandbox refuses to start as root, which is the normal
// way to run on a Linux live-USB (root is needed for DMI serials / memory).
if (process.platform === 'linux' && process.getuid?.() === 0) {
  app.commandLine.appendSwitch('no-sandbox');
}

// The packaged Windows app always runs elevated (requireAdministrator
// manifest). In that state Chromium failed to launch its sandboxed child
// processes on Windows: first the GPU process ("GPU process launch failed:
// error_code=18"), then renderers (every page load -> ERR_FAILED). So the
// Chromium sandbox is turned off there. Trade-off: the sandbox is a second line
// of defence against hostile web content; Benchwise only loads its own bundled
// pages, and context isolation + the narrow preload API still apply.
if (process.platform === 'win32' && app.isPackaged) {
  app.commandLine.appendSwitch('no-sandbox');
}

// If a GPU/renderer/utility process dies, say which and why (instead of a
// bare ERR_FAILED from whatever page it was serving).
app.on('child-process-gone', (_e, d) => console.error(`[benchwise] child process gone: ${d.type} reason=${d.reason} exitCode=${d.exitCode}`));
app.on('render-process-gone', (_e, _wc, d) => console.error(`[benchwise] renderer gone: reason=${d.reason} exitCode=${d.exitCode}`));

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: 'benchwise-pdf', privileges: { standard: true, secure: true } },
]);

let mainWindow = null;
let settings;
let store;
let lastHardware = null;
let hardwarePromise = null;
let keyboardCapture = false;
let stress = null;
let lastDriveHealth = null;
let onStick = null; // decided once: is the data folder on the stick we run from?
let lastMdm = null;
let mdmPromise = null;
let lastMalware = null;
let malwarePromise = null;
let drivePromise = null;

/** Drive Health test: one check at a time; the latest result goes into the saved report. */
function getDriveHealth() {
  if (!drivePromise) {
    drivePromise = (async () => {
      const hw = lastHardware || (await getHardware().catch(() => null));
      return (lastDriveHealth = await checkDrives({ inventory: hw?.storage || [] }));
    })().finally(() => (drivePromise = null));
  }
  return drivePromise;
}

/** Starts a script in an Electron utility process (separate OS process). */
function forkUtility(file) {
  const child = utilityProcess.fork(file, [], { serviceName: 'Benchwise stress test', stdio: 'ignore' });
  let ready = false;
  const queue = [];
  child.once('spawn', () => {
    ready = true;
    queue.splice(0).forEach((m) => child.postMessage(m));
  });
  return {
    postMessage: (m) => (ready ? child.postMessage(m) : queue.push(m)),
    on: (ev, fn) => child.on(ev, fn),
    kill: () => child.kill(),
  };
}

const appInfo = () => ({
  name: 'Benchwise',
  version: app.getVersion(),
  platform: `${process.platform}-${process.arch}`,
  electron: process.versions.electron,
});

/**
 * Where reports go. In Windows setup, Benchwise runs as the temporary setup
 * account (defaultuser0), whose profile is deleted when setup finishes:
 * reports saved there are lost. Running from the stick's launcher avoids it.
 */
function storageInfo() {
  const dir = settings.reportsDir();
  onStick ??= detectStick({ dataDir: settings.dataDir, exeDir: process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe')) });
  const kind = classifyStorage(dir, { dataDir: settings.dataDir, onStick });
  return { reportsDir: dir, dataDir: settings.dataDir, kind, temporary: kind === 'temporary' };
}

/** Touch support per display, from Chromium's view of the hardware. */
function touchSupport() {
  try {
    const values = screen.getAllDisplays().map((d) => d.touchSupport);
    if (values.includes('available')) return 'available';
    if (values.length && values.every((v) => v === 'unavailable')) return 'unavailable';
  } catch {
    /* screen not ready */
  }
  return 'unknown';
}

function getHardware(force = false) {
  if (force || !hardwarePromise) {
    hardwarePromise = collectHardware().then((hw) => {
      hw.capabilities = { ...hw.capabilities, touch: touchSupport() };
      return (lastHardware = hw);
    });
    hardwarePromise.catch(() => (hardwarePromise = null));
  }
  return hardwarePromise;
}

// ------------------------------------------------------------------ PDF

let logoDataUrl = null;
function logo() {
  if (logoDataUrl === null) {
    try {
      logoDataUrl = `data:image/png;base64,${fs.readFileSync(path.join(RENDERER_ROOT, 'assets', 'logo.png')).toString('base64')}`;
    } catch {
      logoDataUrl = '';
    }
  }
  return logoDataUrl;
}

// Report HTML is served from memory on a private, in-memory session rather
// than written to a temp file: the packaged, elevated Windows app couldn't load
// file:// URLs from %TEMP% (ERR_FAILED), and this avoids paths/ACLs everywhere.
const pdfPages = new Map(); // id -> html
let pdfSession = null;

function getPdfSession() {
  if (!pdfSession) {
    pdfSession = session.fromPartition('benchwise-pdf'); // no "persist:" = memory only
    pdfSession.protocol.handle('benchwise-pdf', (request) => {
      const html = pdfPages.get(new URL(request.url).hostname);
      return html
        ? new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
        : new Response('Not found', { status: 404 });
    });
  }
  return pdfSession;
}

async function renderPdf(audit) {
  const html = await renderReportHtml(audit, { logoDataUrl: logo() });
  const id = crypto.randomUUID();
  pdfPages.set(id, html);
  const win = new BrowserWindow({ show: false, webPreferences: { session: getPdfSession(), sandbox: true, javascript: false } });
  try {
    await win.loadURL(`benchwise-pdf://${id}/report.html`);
    return await win.webContents.printToPDF({ pageSize: 'Letter', printBackground: true });
  } finally {
    win.destroy();
    pdfPages.delete(id);
  }
}

// ------------------------------------------------------------------ IPC

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    // Only our own UI may call in.
    if (!event.senderFrame?.url?.startsWith(APP_ORIGIN)) throw new Error('Untrusted sender');
    return fn(...args);
  });
}

function registerIpc() {
  handle('app:info', async () => ({ ...appInfo(), elevated: await isElevated(), storage: storageInfo() }));
  // Intake "Done" screen. Shutdown is Windows-only and asks in the UI first.
  handle('app:quit', () => setTimeout(() => app.quit(), 200));
  handle('system:shutdown', () => {
    if (process.platform !== 'win32') throw new Error('Shut down is only available on Windows.');
    execFile('shutdown', ['/s', '/t', '0'], { windowsHide: true }, () => {});
  });
  handle('hardware:collect', (force) => getHardware(Boolean(force)));
  handle('drives:check', () => getDriveHealth());
  // Defender scan (definition update + quick scan: minutes). One at a time.
  handle('malware:run', () => {
    if (!malwarePromise) {
      malwarePromise = (async () => {
        if (process.platform !== 'win32') return { status: 'unavailable', message: 'Microsoft Defender is Windows only.', threats: [], verdict: { status: null, summary: 'Windows only.' } };
        const result = await runDefenderScan({ onProgress: (p) => mainWindow?.webContents.send('malware:progress', p) });
        return (lastMalware = { ...result, verdict: malwareVerdict(result, { malwareFails: settings.get().malwareFails }) });
      })().finally(() => (malwarePromise = null));
    }
    return malwarePromise;
  });
  // MDM / Autopilot check (~30 s+). One run at a time; progress streams to the UI.
  handle('mdm:run', () => {
    if (!mdmPromise) {
      mdmPromise = (async () => {
        const s = settings.get();
        // BENCHWISE_KNOWN_TENANTS: set by the stick launcher's site.cmd (the intake share's list).
        const known = await loadKnownTenants([process.env.BENCHWISE_KNOWN_TENANTS, s.knownTenantsFile, path.join(settings.dataDir, 'KnownTenants.txt')]);
        const result = await runMdmCheck({
          known: known.map,
          onProgress: (p) => mainWindow?.webContents.send('mdm:progress', p),
        });
        const verdict = mdmVerdict(result, { lockedFails: s.mdmLockedFails });
        return (lastMdm = { ...result, verdict, knownTenantsSource: known.source ? path.basename(known.source) : null });
      })().finally(() => (mdmPromise = null));
    }
    return mdmPromise;
  });
  // USB port test (test drive)
  const ports = new PortWatcher();
  handle('ports:start', () => ports.start());
  handle('ports:poll', () => ports.poll());
  handle('ports:stop', () => ports.stop());
  handle('ports:volumes', () => listVolumes());
  handle('ports:prepare', async (mount) => {
    const marker = await prepareDrive(String(mount));
    const ejected = await ejectVolume(String(mount));
    return { marker, ejected };
  });
  handle('settings:get', () => settings.get());
  handle('settings:update', (partial) => settings.update(partial));

  handle('dialog:chooseDir', async () => {
    const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });

  handle('media:ensureAccess', async () => {
    if (process.platform !== 'darwin' || uiCheckArg) return { camera: true, microphone: true };
    const [camera, microphone] = await Promise.all([
      systemPreferences.askForMediaAccess('camera'),
      systemPreferences.askForMediaAccess('microphone'),
    ]);
    return { camera, microphone };
  });

  handle('audit:save', async (input) => {
    const hw = lastHardware || (await getHardware());
    const hardware = { ...hw, ...(lastDriveHealth && { driveHealth: lastDriveHealth }), ...((lastMdm || lastMalware) && { intake: { mdm: lastMdm, malware: lastMalware } }) };
    const audit = buildAudit({ input: input || {}, hardware, settings: settings.get(), app: appInfo() });
    try {
      const saved = await store.save(audit);
      return { ...saved, overall: audit.overall, id: audit.id };
    } catch (err) {
      // The reports folder (often a network share) failed: keep the record on
      // the stick / local data folder instead, like the intake toolkit's
      // offline backup. Never lose a result.
      const local = path.join(settings.dataDir, 'reports');
      if (path.resolve(store.dir) === path.resolve(local)) throw err;
      const saved = await new ReportStore(() => local, renderPdf).save(audit);
      return { ...saved, overall: audit.overall, id: audit.id, fallback: { failedDir: store.dir, reason: err.message } };
    }
  });

  handle('keyboard:capture', (on) => {
    keyboardCapture = Boolean(on);
  });

  // Stress tests run in an isolated utility process; events stream to the UI.
  // Telemetry comes from a worker thread so slow sensors can't stall the app.
  const telemetry = new TelemetrySampler();
  stress = new StressManager({
    fork: forkUtility,
    sampleTelemetry: async () => telemetry.latest(),
    memInfo: () => memInfo(() => si.mem()),
    emit: (event) => mainWindow?.webContents.send('stress:event', event),
  });
  handle('stress:profiles', () => stress.profiles());
  handle('stress:status', () => stress.status());
  // UI check: real runs, but seconds instead of minutes.
  handle('stress:start', (kind, profile) => stress.start(String(kind), String(profile), uiCheckArg ? { durationMs: 4000, bytes: 64 * 1024 * 1024 } : {}));
  handle('stress:stop', () => stress.stop());

  handle('reports:list', () => store.list());
  handle('reports:open', async (file, ext) => {
    const err = await shell.openPath(store.resolve(file, ext));
    if (err) throw new Error(err);
  });
  handle('reports:reveal', (file) => shell.showItemInFolder(store.resolve(file, 'json')));
  handle('reports:openDir', async () => {
    await fsp.mkdir(store.dir, { recursive: true });
    await shell.openPath(store.dir);
  });
}

// ------------------------------------------------------------------ window

function registerAppProtocol() {
  protocol.handle('app', (request) => {
    const { host, pathname } = new URL(request.url);
    const file = path.normalize(path.join(RENDERER_ROOT, decodeURIComponent(pathname)));
    if (host !== 'benchwise' || !file.startsWith(RENDERER_ROOT + path.sep)) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

function lockDownSessions() {
  const ses = session.defaultSession;
  const allowed = new Set(['media', 'fullscreen', 'speaker-selection']);
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    callback(allowed.has(permission) && wc.getURL().startsWith(APP_ORIGIN));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    return allowed.has(permission) && requestingOrigin?.startsWith(APP_ORIGIN);
  });
  ses.setDevicePermissionHandler(() => false);

  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith(APP_ORIGIN)) event.preventDefault();
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'Benchwise',
    backgroundColor: '#0f1115',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    paintWhenInitiallyHidden: true,
  });
  mainWindow.once('ready-to-show', () => {
    // UI check stays hidden locally, but on CI (a virtual display nobody sees)
    // it's shown so frames always repaint and screenshots are reliable.
    if (!uiCheckArg) mainWindow.show();
    else if (process.env.CI) mainWindow.showInactive();
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!keyboardCapture) return;
    event.preventDefault(); // blocks page handling AND menu accelerators
    mainWindow.webContents.send('keyboard:key', {
      type: input.type === 'keyDown' ? 'down' : 'up',
      code: input.code,
      key: input.key,
      repeat: Boolean(input.isAutoRepeat),
    });
  });
  mainWindow.on('blur', () => mainWindow?.webContents.send('keyboard:key', { type: 'blur' }));
  mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
  mainWindow.on('closed', () => (mainWindow = null));
}

// ------------------------------------------------------------------ smoke test

async function runSmokeTest() {
  const outDir = smokeArg.includes('=')
    ? path.resolve(smokeArg.split('=')[1])
    : fs.mkdtempSync(path.join(os.tmpdir(), 'benchwise-smoke-'));
  const smokeStore = new ReportStore(() => outDir, renderPdf);
  const hw = await collectHardware();
  hw.driveHealth = await checkDrives({ inventory: hw.storage });
  const tool = hw.driveHealth.tool || null;
  // Release builds must carry their own smartctl (checks the packaging).
  if (process.env.BENCHWISE_REQUIRE_BUNDLED_SMARTCTL === '1' && tool?.source !== 'bundled') {
    throw new Error(`bundled smartctl not found (got ${tool ? `${tool.source}: ${tool.file}` : 'none'})`);
  }
  const audit = buildAudit({
    input: {
      assetTag: 'SMOKE-TEST',
      technician: 'smoke',
      tests: { keyboard: { status: 'pass', details: { keysRegistered: '87/87' } }, camera: { status: 'na' } },
      media: {},
    },
    hardware: hw,
    settings: { ...settings.get(), assetTagPattern: '' },
    app: appInfo(),
  });
  const saved = await smokeStore.save(audit);
  const listed = await smokeStore.list();
  const summary = {
    ok: Boolean(saved.pdfPath),
    saved,
    listed: listed.length,
    durationMs: hw.durationMs,
    warnings: hw.warnings,
    driveHealth: { tool, error: hw.driveHealth.error || null, drives: hw.driveHealth.drives.length, verdict: hw.driveHealth.verdict },
  };
  fs.writeFileSync(path.join(outDir, 'smoke-result.json'), JSON.stringify(summary, null, 2));
  await new Promise((resolve) => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`, resolve));
  if (!saved.pdfPath) throw new Error(`PDF failed: ${saved.pdfError}`);
}

// ------------------------------------------------------------------ UI check

// `--ui-check=<dir>`: loads the real UI hidden, visits pages that need no
// camera/mic permission, saves screenshots, and fails on any console error.
const uiCheckArg = process.argv.find((a) => a.startsWith('--ui-check='));

async function runUiCheck() {
  const outDir = path.resolve(uiCheckArg.split('=')[1]);
  fs.mkdirSync(outDir, { recursive: true });
  const errors = [];
  mainWindow.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') errors.push(`${e.level}: ${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
  mainWindow.webContents.on('preload-error', (_e, p, err) => errors.push(`preload: ${err.message}`));
  const js = (code) => mainWindow.webContents.executeJavaScript(code);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Screenshots are evidence, not the check itself: retry flaky captures
  // (Chromium's "UnknownVizError" under xvfb) and never fail the run on them.
  const shotFailures = [];
  const shot = async (name) => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const img = await mainWindow.webContents.capturePage();
        if (!img.isEmpty()) return fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
      } catch (err) {
        if (attempt === 4) shotFailures.push(`${name}: ${err.message}`);
      }
      await wait(400);
    }
  };
  const click = (label) =>
    js(`(() => { const b = [...document.querySelectorAll('.nav-item')].find(b => b.textContent.startsWith(${JSON.stringify(label)})); if (!b) throw new Error('nav not found: ${label}'); b.click(); })()`);

  await new Promise((r) => mainWindow.webContents.once('did-finish-load', r));
  // Normally the Overview; in Windows setup the intake flow opens the MDM page.
  for (let i = 0; i < 60 && !(await js(`!!document.querySelector('.cards, .mdm-check')`)); i++) await wait(500);
  if (await js(`!!document.querySelector('.profile-switch')`)) {
    // Intake (OOBE or BENCHWISE_ENV_MODE=oobe): both checks run by themselves,
    // then the summary opens. Then switch to the full audit for the rest.
    await shot('0a-intake-start');
    const onSummary = `document.querySelector('h1')?.textContent === 'Intake summary'`;
    for (let i = 0; i < 400 && !(await js(onSummary)); i++) await wait(500);
    await wait(500);
    await shot('0c-intake-summary');
    if (!(await js(onSummary))) errors.push('intake: the summary never opened');
    // Save the intake record (no asset tag: named by serial), then the Done
    // buttons. On a stick or share it has already saved itself.
    for (let i = 0; i < 12 && !(await js(`!!document.querySelector('.card.saved')`)); i++) await wait(250);
    if (!(await js(`!!document.querySelector('.card.saved')`))) {
      await js(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Save report')?.click()`);
    }
    for (let i = 0; i < 40 && !(await js(`!!document.querySelector('.card.saved')`)); i++) await wait(250);
    await js(`document.querySelector('.card.saved')?.scrollIntoView()`);
    await wait(300);
    await shot('0d-intake-saved');
    if (!(await js(`[...document.querySelectorAll('.done-actions button')].map(b => b.textContent).join('|') === 'Shut down|Exit to Windows setup'`))) {
      errors.push('intake: Shut down / Exit buttons missing after save');
    }
    await js(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Run the full audit →')?.click()`);
    await wait(600);
    await click('System Overview');
    for (let i = 0; i < 20 && !(await js(`!!document.querySelector('.cards')`)); i++) await wait(500);
  }
  await wait(500); // let a hidden window repaint before capture (Windows serves stale frames otherwise)
  await shot('1-overview');
  await js(`document.getElementById('assetTagInput').value='TEST-001'; document.getElementById('assetTagInput').dispatchEvent(new Event('input'))`);
  for (const [label, name] of [
    ['Keyboard', '2-keyboard'],
    ['Display', '3-display'],
    ['Touchscreen', '3b-touch'],
    ['USB Ports', '4-ports'],
    ['MDM / Autopilot', '0-mdm'],
    ['Malware Scan', '0b-malware'],
    ['Drive Health', '4b-drives'],
    ['Finish', '5-finish'],
  ]) {
    await click(label);
    await wait(name === '4-ports' ? 3000 : 600);
    if (label === 'Malware Scan') {
      // Only runs in OOBE (or BENCHWISE_ENV_MODE=oobe): wait for the result.
      for (let i = 0; i < 240 && (await js(`!!document.querySelector('.malware-scan .spinner')`)); i++) await wait(500);
    }
    if (label === 'MDM / Autopilot') {
      // Only runs when Benchwise is in OOBE (or BENCHWISE_ENV_MODE=oobe): wait for the result.
      for (let i = 0; i < 200 && (await js(`!!document.querySelector('.mdm-check .spinner')`)); i++) await wait(500);
    }
    if (label === 'Drive Health') {
      // CI VMs have virtual disks only, so this is often auto-N/A.
      await js(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Run this test anyway')?.click()`);
      for (let i = 0; i < 120 && (await js(`!!document.querySelector('.drive-health .spinner')`)); i++) await wait(500);
      await wait(300);
    }
    if (label === 'Keyboard' || label === 'Display') {
      // CI machines are VMs that report a Desktop chassis, where these are
      // auto-N/A (peripherals). Override like an operator would, so the test
      // UI itself (and the override button) still get exercised.
      const overridden = await js(
        `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent === 'Run this test anyway'); if (b) b.click(); return !!b; })()`,
      );
      if (overridden) await wait(600);
    }
    await shot(name);
    if (name === '2-keyboard') {
      // Widest layout: the full board must fit without horizontal scrolling.
      await js(`(() => { const s = document.querySelector('.keyboard').closest('.test-body').querySelector('select'); s.value = 'full'; s.dispatchEvent(new Event('change')); })()`);
      await wait(400);
      await shot('2b-keyboard-full');
      if (await js(`(() => { const k = document.querySelector('.keyboard'); return k.scrollWidth > k.clientWidth + 1; })()`)) {
        errors.push('keyboard: full-size layout overflows horizontally');
      }
    }
  }
  // Stress tests: real runs in the utility process (shortened in UI-check mode).
  for (const [label, kind, name] of [['CPU Stress', 'cpu', '8-cpu'], ['Memory Test', 'memory', '9-memory']]) {
    await click(label);
    await wait(500);
    await js(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Start').click()`);
    await wait(2500);
    await shot(`${name}-running`);
    for (let i = 0; i < 60 && (await js(`!!document.querySelector('.nav-item .spinner')`)); i++) await wait(500);
    await wait(300);
    await shot(`${name}-done`);
    const status = await js(`document.querySelector('.nav-item.active .dot')?.className || ''`);
    if (!status.includes('s-pass')) errors.push(`${kind} stress: expected pass, nav shows "${status}"`);
  }
  await click('Finish');
  await wait(500);

  // Save through the real UI and confirm it lands in the Reports list.
  await js(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Save report').click()`);
  for (let i = 0; i < 40 && !(await js(`!!document.querySelector('.card.saved')`)); i++) await wait(250);
  if (!(await js(`!!document.querySelector('.card.saved')`))) errors.push('save: no confirmation shown');
  await shot('5b-saved');
  await click('Reports');
  await wait(800);
  if (!(await js(`[...document.querySelectorAll('td strong')].some(s => s.textContent === 'TEST-001')`))) errors.push('reports: saved audit not listed');
  await shot('6-reports');
  await click('Settings');
  await wait(400);
  await shot('7-settings');
  await click('System Overview');
  const summary = { ok: errors.length === 0, errors, screenshotFailures: shotFailures };
  fs.writeFileSync(path.join(outDir, 'ui-check.json'), JSON.stringify(summary, null, 2));
  await new Promise((r) => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`, r));
  return summary.ok;
}

// ------------------------------------------------------------------ lifecycle

if (!smokeArg && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    settings = new Settings(resolveDataDir(app));
    store = new ReportStore(() => settings.reportsDir(), renderPdf);

    // Linux: offer to relaunch as root (Windows elevates via the exe manifest).
    if (!smokeArg && !uiCheckArg) {
      if ((await ensureLinuxElevation({ app, dialog, dataDir: settings.dataDir })) === 'exit') {
        app.exit(0);
        return;
      }
    }

    if (smokeArg) {
      try {
        await runSmokeTest();
        app.exit(0);
      } catch (err) {
        console.error('SMOKE TEST FAILED:', err);
        app.exit(1);
      }
      return;
    }

    registerAppProtocol();
    lockDownSessions();
    registerIpc();
    createWindow();
    getHardware().catch(() => {}); // start scanning while the UI loads

    if (uiCheckArg) {
      runUiCheck().then(
        (ok) => app.exit(ok ? 0 : 1),
        (err) => {
          console.error('UI CHECK FAILED:', err);
          app.exit(1);
        },
      );
    }
  });

  // Only the main window closing should quit; hidden PDF-render windows
  // closing must not (that previously killed the app mid-save).
  app.on('before-quit', () => stress?.dispose());

  app.on('window-all-closed', () => {
    if (!smokeArg && !mainWindow) app.quit();
  });
}
