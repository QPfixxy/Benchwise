'use strict';

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, protocol, net, session, shell, dialog, systemPreferences, screen, utilityProcess } = require('electron');
const si = require('systeminformation');
const { StressManager } = require('./stress/manager');
const { isElevated, ensureLinuxElevation } = require('./elevation');

const { collectHardware } = require('./hardware/collect');
const { PortWatcher, listVolumes, prepareDrive, ejectVolume } = require('./ports/testdrive');
const { Settings, resolveDataDir } = require('./settings');
const { ReportStore, buildAudit } = require('./reports/store');
const { renderReportHtml } = require('./reports/template');

const RENDERER_ROOT = path.join(__dirname, '..', 'renderer');
const APP_ORIGIN = 'app://qudit';
const smokeArgs = process.argv.filter((a) => a.startsWith('--smoke-test'));
const smokeArg = smokeArgs.find((a) => a.includes('=')) || smokeArgs[0];

// Electron's Chromium sandbox refuses to start as root, which is the normal
// way to run on a Linux live-USB (root is needed for DMI serials / memory).
if (process.platform === 'linux' && process.getuid?.() === 0) {
  app.commandLine.appendSwitch('no-sandbox');
}

// The packaged Windows app runs elevated (requireAdministrator manifest).
// There Chromium can fail to launch the *GPU process* sandbox
// ("GPU process launch failed: error_code=18" -> "GPU process isn't usable.
// Goodbye.") and the app exits. Disable just that sandbox; renderer pages stay
// sandboxed, and an elevated process gains little from it anyway.
if (process.platform === 'win32' && app.isPackaged) {
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: 'qudit-pdf', privileges: { standard: true, secure: true } },
]);

let mainWindow = null;
let settings;
let store;
let lastHardware = null;
let hardwarePromise = null;
let keyboardCapture = false;
let stress = null;

/** Starts a script in an Electron utility process (separate OS process). */
function forkUtility(file) {
  const child = utilityProcess.fork(file, [], { serviceName: 'Qudit stress test', stdio: 'ignore' });
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
  name: 'Qudit',
  version: app.getVersion(),
  platform: `${process.platform}-${process.arch}`,
  electron: process.versions.electron,
});

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
      logoDataUrl = `data:image/png;base64,${fs.readFileSync(path.join(RENDERER_ROOT, 'assets', 'qudit.png')).toString('base64')}`;
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
    pdfSession = session.fromPartition('qudit-pdf'); // no "persist:" = memory only
    pdfSession.protocol.handle('qudit-pdf', (request) => {
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
    await win.loadURL(`qudit-pdf://${id}/report.html`);
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
  handle('app:info', async () => ({ ...appInfo(), elevated: await isElevated() }));
  handle('hardware:collect', (force) => getHardware(Boolean(force)));
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
    const hardware = lastHardware || (await getHardware());
    const audit = buildAudit({ input: input || {}, hardware, settings: settings.get(), app: appInfo() });
    const saved = await store.save(audit);
    return { ...saved, overall: audit.overall, id: audit.id };
  });

  handle('keyboard:capture', (on) => {
    keyboardCapture = Boolean(on);
  });

  // Stress tests run in an isolated utility process; events stream to the UI.
  stress = new StressManager({
    fork: forkUtility,
    sampleTelemetry: async () => {
      const [temp, speed] = await Promise.all([si.cpuTemperature().catch(() => ({})), si.cpuCurrentSpeed().catch(() => ({}))]);
      return { tempC: temp.main > 0 ? temp.main : null, ghz: speed.avg > 0 ? speed.avg : null };
    },
    memInfo: () => si.mem(),
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
    if (host !== 'qudit' || !file.startsWith(RENDERER_ROOT + path.sep)) {
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
    title: 'Qudit',
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
    : fs.mkdtempSync(path.join(os.tmpdir(), 'qudit-smoke-'));
  const smokeStore = new ReportStore(() => outDir, renderPdf);
  const hw = await collectHardware();
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
  const summary = { ok: Boolean(saved.pdfPath), saved, listed: listed.length, durationMs: hw.durationMs, warnings: hw.warnings };
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
  for (let i = 0; i < 60 && !(await js(`!!document.querySelector('.cards')`)); i++) await wait(500);
  await wait(500); // let a hidden window repaint before capture (Windows serves stale frames otherwise)
  await shot('1-overview');
  await js(`document.getElementById('assetTagInput').value='TEST-001'; document.getElementById('assetTagInput').dispatchEvent(new Event('input'))`);
  for (const [label, name] of [['Keyboard', '2-keyboard'], ['Display', '3-display'], ['Touchscreen', '3b-touch'], ['USB Ports', '4-ports'], ['Finish', '5-finish']]) {
    await click(label);
    await wait(name === '4-ports' ? 3000 : 600);
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
