import { el, append, clear, toast, statusBadge } from './dom.js';
import { TESTS } from './tests/index.js';
import { startMalwareScan } from './tests/malware.js';
import { applicability } from './applicability.js';
import { rankDevices } from './devices.js';
import overview from './views/overview.js';
import finish from './views/finish.js';
import reports from './views/reports.js';
import settingsView from './views/settings.js';

const api = window.benchwise;

export const state = {
  info: null,
  settings: null,
  hardware: null,
  hardwareError: null,
  scanning: false,
  media: { cameras: [], microphones: [], speakers: [] },
  session: null,
  route: 'overview',
  stress: { running: null, last: {} },
  busy: {}, // test id -> true while a background check runs (sidebar spinner)
  environment: null, // where we're running; known before the hardware scan ends
};

const listeners = new Set();
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  applyApplicability();
  renderNav();
  renderSessionBar();
  for (const fn of listeners) fn(state);
  maybeFinishIntake();
}

// ------------------------------------------------------------------ session

function newSession() {
  state.session = {
    assetTag: '',
    technician: state.settings?.defaultTechnician || '',
    notes: '',
    startedAt: new Date().toISOString(),
    tests: Object.fromEntries(stationTests().map((t) => [t.id, { status: 'untested', notes: '', details: {} }])),
    // 'intake' (Windows setup: lock + malware checks) or 'full'. Chosen once
    // the hardware scan says where we're running; null until then.
    profile: state.environment || state.hardware ? defaultProfile() : null,
  };
}

// Tests per profile; null = every test enabled in Settings.
const PROFILE_TESTS = { full: null, intake: ['mdm', 'malware'] };
export const PROFILE_LABELS = { intake: 'Intake checks', full: 'Full audit' };

export const inSetup = () => (state.environment?.mode ?? state.hardware?.environment?.mode) === 'oobe';
const defaultProfile = () => (inSetup() ? 'intake' : 'full');

/** Switches between the intake checks and the full audit (results are kept). */
export function setProfile(profile) {
  if (!(profile in PROFILE_TESTS)) return;
  state.session.profile = profile;
  emit();
  renderView();
}

/** Marks a test as running in the background (sidebar spinner). */
export function setBusy(id, on) {
  state.busy = { ...state.busy, [id]: Boolean(on) };
  emit();
}

/** Every test enabled at this station (Settings). */
function stationTests() {
  return TESTS.filter((t) => state.settings?.enabledTests?.[t.id] !== false);
}

/** The tests of the current profile: what the sidebar, verdict and report cover. */
export function enabledTests() {
  const only = PROFILE_TESTS[state.session?.profile || 'full'];
  return stationTests().filter((t) => !only || only.includes(t.id));
}

export function setTestResult(id, { status, details, notes }) {
  const cur = state.session.tests[id] || { status: 'untested', notes: '', details: {} };
  state.session.tests[id] = {
    ...cur,
    status: status ?? cur.status,
    details: details ?? cur.details,
    notes: notes ?? cur.notes,
    completedAt: status && status !== 'untested' ? new Date().toISOString() : cur.completedAt,
    // Any explicit verdict from the operator or the test replaces an auto N/A.
    auto: status ? false : cur.auto,
  };
  emit();
}

// ------------------------------------------------------------------ applicability

export function testApplicability(id) {
  return applicability(id, { hardware: state.hardware, media: state.media, maxTouchPoints: navigator.maxTouchPoints || 0 });
}

/** Auto-records N/A for hardware the unit doesn't have; reverts if it appears. */
function applyApplicability() {
  if (!state.session || !state.hardware) return;
  for (const t of enabledTests()) {
    const r = state.session.tests[t.id];
    if (!r || r.override) continue;
    const a = testApplicability(t.id);
    if (a.state === 'na' && r.status === 'untested') {
      Object.assign(r, { status: 'na', auto: true, details: { autoNa: a.reason }, completedAt: new Date().toISOString() });
    } else if (a.state !== 'na' && r.auto && r.status === 'na') {
      Object.assign(r, { status: 'untested', auto: false, details: {}, completedAt: null });
    }
  }
}

/** Operator chose to run a test that was auto-marked N/A. */
export function overrideApplicability(id) {
  const r = state.session.tests[id];
  Object.assign(r, { override: true, auto: false, status: 'untested', details: {}, completedAt: null });
  emit();
  renderView();
}

export function overall() {
  const statuses = enabledTests().map((t) => state.session.tests[t.id]?.status || 'untested');
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('untested')) return 'incomplete';
  return 'pass';
}

/** Mirrors the main-process validation so the operator gets instant feedback. */
export function validateAssetTag(tag) {
  const v = (tag || '').trim();
  if (!v) return state.settings.assetTagRequired ? `${state.settings.assetTagLabel} is required.` : null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v)) return 'Use letters, digits, dot, dash or underscore (max 64).';
  const p = state.settings.assetTagPattern;
  if (p) {
    try {
      if (!new RegExp(`^(?:${p})$`).test(v)) return `Must match the format ${p}.`;
    } catch {
      return 'The asset tag pattern in Settings is invalid.';
    }
  }
  return null;
}

export function startNewAudit() {
  state.mdm = null;
  state.malware = null;
  state.driveHealth = null;
  newSession();
  navigate('overview');
  emit();
  document.getElementById('assetTagInput')?.focus();
}

// ------------------------------------------------------------------ hardware & media

export async function scanHardware(force = false) {
  state.scanning = true;
  state.hardwareError = null;
  emit();
  try {
    state.hardware = await api.collectHardware(force);
  } catch (err) {
    state.hardwareError = err.message;
  } finally {
    state.scanning = false;
    emit();
  }
  if (state.hardware && state.session && !state.session.profile) beginSession();
}

/**
 * First scan done: pick the profile. In Windows setup that's intake, with
 * zero clicks: the malware scan starts in the background (it's the slow one)
 * and the MDM page opens, which runs its check straight away.
 */
function beginSession() {
  state.session.profile = defaultProfile();
  emit();
  if (state.session.profile !== 'intake') return;
  const ready = (id) => enabledTests().some((t) => t.id === id) && testApplicability(id).state === 'ready';
  if (ready('malware')) {
    startMalwareScan({
      api,
      state,
      setResult: (r) => setTestResult('malware', r),
      getResult: () => state.session.tests.malware,
    });
  }
  if (ready('mdm')) navigate('test:mdm');
}

/** Intake: when both checks have a result, show the summary (once per unit). */
function maybeFinishIntake() {
  const s = state.session;
  if (!s || s.profile !== 'intake' || s.intakeSummaryShown) return;
  if (!state.route.startsWith('test:')) return;
  const done = (id) => !enabledTests().some((t) => t.id === id) || testApplicability(id).state !== 'ready' || state[id];
  if (state.busy.mdm || state.busy.malware || !done('mdm') || !done('malware')) return;
  s.intakeSummaryShown = true;
  setTimeout(() => navigate('finish'), 1500); // let the last result be seen
}

export async function refreshMedia() {
  try {
    await api.ensureMediaAccess();
    const devices = await navigator.mediaDevices.enumerateDevices();
    // [{ label }] ranked built-in first; "default"/"communications" are aliases.
    const list = (kind) => {
      const seen = new Set();
      return rankDevices(
        devices
          .filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications')
          .map((d) => ({ label: d.label || 'Unnamed device' })),
      ).filter((d) => !seen.has(d.label) && seen.add(d.label));
    };
    state.media = { cameras: list('videoinput'), microphones: list('audioinput'), speakers: list('audiooutput') };
  } catch {
    /* keep previous */
  }
  emit();
}

// ------------------------------------------------------------------ routing

let cleanupView = null;

export function navigate(route) {
  state.route = route;
  renderView();
  renderNav();
}

function renderView() {
  try {
    cleanupView?.();
  } catch (err) {
    console.error(err);
  }
  cleanupView = null;
  const view = clear(document.getElementById('view'));
  view.scrollTop = 0;

  const ctxBase = { state, api, navigate, setTestResult, scanHardware, refreshMedia, startNewAudit, onChange };

  if (state.route.startsWith('test:')) {
    const tests = enabledTests();
    const idx = tests.findIndex((t) => `test:${t.id}` === state.route);
    const test = tests[idx];
    if (!test) return navigate('overview');
    // "Next" skips tests auto-marked N/A for this unit.
    const next = tests.slice(idx + 1).find((t) => !state.session.tests[t.id]?.auto);
    cleanupView = mountTest(view, test, next, ctxBase);
    return;
  }
  const views = { overview, finish, reports, settings: settingsView };
  cleanupView = (views[state.route] || overview).mount(view, ctxBase) || null;
}

function mountTest(view, test, next, ctxBase) {
  const body = el('div', { class: 'test-body' });
  view.append(
    el(
      'div',
      { class: 'page-head' },
      el('div', {}, el('h1', {}, test.name), el('p', { class: 'muted' }, test.description)),
      el(
        'div',
        { class: 'row' },
        next
          ? el('button', { class: 'btn', onclick: () => navigate(`test:${next.id}`) }, `Next: ${next.name} →`)
          : el('button', { class: 'btn primary', onclick: () => navigate('finish') }, 'Finish audit →'),
      ),
    ),
    body,
  );

  const result = state.session.tests[test.id];
  const a = testApplicability(test.id);
  if (result?.auto && result.status === 'na') {
    body.append(
      el(
        'div',
        { class: 'notice na' },
        el('strong', {}, 'Not applicable to this unit'),
        el('p', {}, a.reason || result.details?.autoNa || ''),
        el('p', { class: 'muted small' }, 'Recorded as N/A automatically.'),
        el('button', { class: 'btn', onclick: () => overrideApplicability(test.id) }, 'Run this test anyway'),
      ),
    );
    return null;
  }
  if (a.state === 'missing') body.append(el('div', { class: 'notice missing' }, el('strong', {}, 'Expected hardware not detected'), el('p', {}, a.reason)));
  else if (a.warning) body.append(el('div', { class: 'notice warn' }, el('p', {}, a.warning)));

  const ctx = {
    ...ctxBase,
    get result() {
      return state.session.tests[test.id];
    },
    setResult: (r) => setTestResult(test.id, r),
    onChange,
  };
  return test.mount(body, ctx);
}

// ------------------------------------------------------------------ chrome

function renderNav() {
  const nav = clear(document.getElementById('nav'));
  const link = (route, label, extra) =>
    el(
      'button',
      { class: `nav-item${state.route === route ? ' active' : ''}`, onclick: () => navigate(route) },
      el('span', {}, label),
      extra,
    );
  append(nav, [
    link('overview', 'System Overview', state.scanning ? el('span', { class: 'spinner sm' }) : null),
    inSetup() && state.session.profile
      ? el(
          'div',
          { class: 'profile-switch', role: 'group', 'aria-label': 'Test profile' },
          ['intake', 'full'].map((p) =>
            el('button', { class: `seg${state.session.profile === p ? ' active' : ''}`, onclick: () => setProfile(p) }, PROFILE_LABELS[p]),
          ),
        )
      : null,
    el('div', { class: 'nav-section' }, 'Tests'),
    enabledTests().map((t) => {
      const r = state.session.tests[t.id];
      const indicator =
        state.stress.running?.kind === t.id || state.busy[t.id] ? el('span', { class: 'spinner sm', title: 'Running' }) : el('span', { class: `dot s-${r?.status || 'untested'}` });
      const node = link(`test:${t.id}`, t.name, indicator);
      if (r?.auto) {
        node.classList.add('auto-na');
        node.title = r.details?.autoNa || 'Not applicable';
      } else if (state.hardware && testApplicability(t.id).state === 'missing' && r?.status === 'untested') {
        node.classList.add('missing');
        node.title = 'Expected hardware not detected';
      }
      return node;
    }),
    el('div', { class: 'nav-section' }, 'Audit'),
    link('finish', 'Finish & Save', statusBadge(overall())),
    link('reports', 'Reports'),
    link('settings', 'Settings'),
  ]);
  const foot = clear(document.getElementById('sidebarFoot'));
  if (state.info) {
    foot.append(`v${state.info.version}${state.settings?.stationName ? ` · ${state.settings.stationName}` : ''}`);
    // null = not applicable (macOS); false = should have admin but doesn't.
    if (state.info.elevated === true) foot.append(el('div', { class: 'pass-text' }, '✓ Administrator'));
    if (state.info.elevated === false) {
      foot.append(el('div', { class: 'warn-text', title: 'Serials, memory module details and drive health may be missing. Restart Benchwise as administrator.' }, '⚠ Limited mode (not administrator)'));
    }
  }
}

function renderSessionBar() {
  const bar = document.getElementById('sessionBar');
  const s = state.session;
  // Don't rebuild while typing: only update the derived bits.
  if (bar.dataset.built === '1') {
    bar.querySelector('#assetTagLabel').textContent = state.settings.assetTagLabel;
    bar.querySelector('.session-overall').replaceChildren(statusBadge(overall()));
    const tag = bar.querySelector('#assetTagInput');
    if (document.activeElement !== tag) tag.value = s.assetTag;
    const tech = bar.querySelector('#technicianInput');
    if (document.activeElement !== tech) tech.value = s.technician;
    return;
  }
  bar.dataset.built = '1';
  const tagInput = el('input', {
    id: 'assetTagInput',
    value: s.assetTag,
    placeholder: state.settings.assetTagPattern ? `Format: ${state.settings.assetTagPattern}` : state.settings.assetTagRequired ? 'Scan or type' : 'Optional',
    autocomplete: 'off',
    spellcheck: 'false',
    oninput: (e) => {
      s.assetTag = e.target.value.trim();
      e.target.classList.toggle('invalid', Boolean(s.assetTag) && Boolean(validateAssetTag(s.assetTag)));
    },
    onkeydown: (e) => {
      // Barcode scanners send Enter after the tag.
      if (e.key === 'Enter') document.getElementById('technicianInput').focus();
    },
  });
  bar.append(
    el('label', { class: 'field' }, el('span', { id: 'assetTagLabel' }, state.settings.assetTagLabel), tagInput),
    el(
      'label',
      { class: 'field' },
      el('span', {}, 'Technician'),
      el('input', {
        id: 'technicianInput',
        value: s.technician,
        placeholder: 'Name or ID',
        oninput: (e) => (s.technician = e.target.value),
      }),
    ),
    el('div', { class: 'session-overall' }, statusBadge(overall())),
    el(
      'button',
      {
        class: 'btn ghost',
        onclick: () => {
          const touched = s.assetTag || Object.values(s.tests).some((t) => t.status !== 'untested');
          if (!touched || confirm('Discard the current audit and start a new one?')) startNewAudit();
        },
      },
      'New audit',
    ),
  );
}

// ------------------------------------------------------------------ boot

async function boot() {
  [state.info, state.settings] = await Promise.all([api.appInfo(), api.getSettings()]);
  newSession();
  emit();
  navigate('overview');
  document.getElementById('assetTagInput')?.focus();
  // Intake doesn't need the hardware scan: start it as soon as we know we're
  // in Windows setup (the scan can take 30 s on some units). If this check
  // fails, the scan's own environment result starts it instead.
  api
    .detectEnvironment()
    .then((env) => {
      state.environment = env;
      if (state.session && !state.session.profile) beginSession();
    })
    .catch(() => {});
  scanHardware();
  refreshMedia();
  navigator.mediaDevices.addEventListener('devicechange', refreshMedia);
  state.stress = await api.stress.status();
  api.stress.onEvent(onStressEvent);
  emit();
}

const STRESS_NAMES = { cpu: 'CPU stress test', memory: 'Memory test' };

/** Stress runs outlive the page that started them; results land here. */
function onStressEvent(e) {
  if (e.type === 'started' || e.type === 'progress') {
    state.stress.running = { kind: e.kind, profile: e.profile, plan: e.plan, progress: e.progress || null };
  } else if (e.type === 'done') {
    state.stress.running = null;
    state.stress.last = { ...state.stress.last, [e.kind]: e };
    if (state.session.tests[e.kind]) {
      setTestResult(e.kind, {
        // No automatic verdict (stopped early) -> back to "not tested".
        status: e.verdict.status || 'untested',
        details: { summary: e.verdict.summary, ...e.verdict.details },
      });
    }
    const v = e.verdict.status;
    toast(`${STRESS_NAMES[e.kind]}: ${v === 'pass' ? 'passed' : v === 'fail' ? 'FAILED' : 'stopped'}`, v === 'fail' ? 'error' : v === 'pass' ? 'success' : 'info');
  }
  emit();
}

export async function reloadSettings() {
  state.settings = await api.getSettings();
  // Tests enabled after the session started need a result slot.
  for (const t of stationTests()) state.session.tests[t.id] ??= { status: 'untested', notes: '', details: {} };
  for (const id of Object.keys(state.session.tests)) {
    if (!stationTests().some((t) => t.id === id)) delete state.session.tests[id];
  }
  emit();
}

boot().catch((err) => {
  console.error(err);
  toast(`Failed to start: ${err.message}`, 'error');
});
