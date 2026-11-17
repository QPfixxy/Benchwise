'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Renderer modules are ES modules; load them dynamically.
const load = () => Promise.all([import('../src/renderer/devices.js'), import('../src/renderer/applicability.js')]);

test('device classification: built-in first, phones and virtual devices excluded', async () => {
  const [{ classifyDevice, rankDevices, unitDevices }] = await load();
  const cases = {
    'FaceTime HD Camera': 'builtin',
    'MacBook Pro Microphone': 'builtin',
    'Integrated Camera (04f2:b6dd)': 'builtin',
    'HP TrueVision HD Camera': 'builtin',
    'Microphone Array (Realtek(R) Audio)': 'builtin',
    'Speakers (Realtek(R) Audio)': 'builtin',
    "Tester's iPhone Camera": 'phone',
    'iPhone Microphone': 'phone',
    'Desk View Camera': 'phone',
    'OBS Virtual Camera': 'virtual',
    'Microsoft Teams Audio': 'virtual',
    'BlackHole 2ch': 'virtual',
    'CABLE Output (VB-Audio Virtual Cable)': 'virtual',
    'Logitech BRIO': 'external',
    'AirPods Max': 'external',
    'Headset Microphone (Jabra Evolve2 65)': 'external',
    'LG UltraFine Display Audio': 'external',
    'Some Camera': 'unknown',
    // Real labels from a MacBook on a dock:
    'MacBook Pro Microphone (Built-in)': 'builtin',
    'Realtek USB2.0 Audio (0bda:498a)': 'external', // dock audio, not the laptop's
    'Odyssey G70B (HDMI)': 'external',
    'AirPods (Bluetooth)': 'external',
  };
  for (const [label, want] of Object.entries(cases)) assert.equal(classifyDevice(label), want, label);

  // The original bug: the iPhone was the default camera.
  const ranked = rankDevices([{ label: 'iPhone Camera' }, { label: 'OBS Virtual Camera' }, { label: 'FaceTime HD Camera' }]);
  assert.equal(ranked[0].label, 'FaceTime HD Camera');
  assert.deepEqual(unitDevices([{ label: 'iPhone Camera' }, { label: 'OBS Virtual Camera' }]), []);
  const speakers = rankDevices([{ label: 'Realtek USB2.0 Audio (0bda:498a)' }, { label: 'MacBook Pro Speakers (Built-in)' }]);
  assert.equal(speakers[0].label, 'MacBook Pro Speakers (Built-in)');
});

test('describeDevice does not repeat "built-in"', async () => {
  const [{ describeDevice }] = await load();
  assert.equal(describeDevice('MacBook Pro Microphone (Built-in)'), 'MacBook Pro Microphone (Built-in)');
  assert.equal(describeDevice('FaceTime HD Camera'), 'FaceTime HD Camera (built-in)');
  assert.equal(describeDevice('iPhone Camera'), 'iPhone Camera (phone: not part of this unit)');
});

const laptop = (extra = {}) => ({
  system: { chassisType: 'Notebook', model: 'MacBookPro18,2' },
  battery: { present: true },
  capabilities: { touch: 'unknown', lidClosed: false },
  ...extra,
});
const desktop = { system: { chassisType: 'Desktop', model: 'OptiPlex 7090' }, battery: { present: false }, capabilities: { touch: 'unavailable' } };

test('applicability: desktops skip A/V they don\'t have, laptops never hide a missing part', async () => {
  const [, { applicability }] = await load();
  const none = { cameras: [], microphones: [], speakers: [] };

  assert.equal(applicability('camera', { hardware: desktop, media: none }).state, 'na');
  assert.equal(applicability('camera', { hardware: laptop(), media: none }).state, 'missing');
  // Only a phone camera present: still "missing" for a laptop (phone isn't the unit's camera).
  assert.equal(applicability('camera', { hardware: laptop(), media: { cameras: [{ label: 'iPhone Camera' }] } }).state, 'missing');
  assert.equal(applicability('camera', { hardware: laptop(), media: { cameras: [{ label: 'FaceTime HD Camera' }] } }).state, 'ready');
  assert.equal(applicability('camera', { hardware: undefined }).state, 'ready'); // not scanned: don't guess
});

test('applicability: touchscreen only when touch hardware exists', async () => {
  const [, { applicability }] = await load();
  assert.equal(applicability('touchscreen', { hardware: desktop }).state, 'na');
  assert.equal(applicability('touchscreen', { hardware: laptop({ capabilities: { touch: 'available' } }) }).state, 'ready');
  assert.equal(applicability('touchscreen', { hardware: laptop(), maxTouchPoints: 10 }).state, 'ready');
});

test('applicability: lid closed explains a missing camera and warns on display/keyboard', async () => {
  const [, { applicability }] = await load();
  const hw = laptop({ capabilities: { lidClosed: true } });
  const cam = applicability('camera', { hardware: hw, media: { cameras: [{ label: 'iPhone Camera' }] } });
  assert.equal(cam.state, 'missing');
  assert.match(cam.reason, /lid is closed/i);
  assert.match(applicability('display', { hardware: hw }).warning, /lid is closed/i);
  assert.match(applicability('keyboard', { hardware: hw }).warning, /lid is closed/i);
  assert.equal(applicability('display', { hardware: laptop() }).warning, null);
});

test('applicability: screen and keyboard are peripherals on desktops, not on laptops', async () => {
  const [, { applicability }] = await load();
  const unit = (formFactor) => ({ system: { formFactor }, battery: { present: false }, capabilities: {} });

  for (const ff of ['desktop', 'server']) {
    const d = applicability('display', { hardware: unit(ff) });
    assert.equal(d.state, 'na', ff);
    assert.match(d.reason, /monitor is a separate peripheral/);
    assert.equal(applicability('keyboard', { hardware: unit(ff) }).state, 'na', ff);
  }
  // All-in-one: built-in screen, separate keyboard.
  assert.equal(applicability('display', { hardware: unit('all-in-one') }).state, 'ready');
  assert.equal(applicability('keyboard', { hardware: unit('all-in-one') }).state, 'na');
  // Tablet: built-in screen, no keyboard.
  assert.equal(applicability('display', { hardware: unit('tablet') }).state, 'ready');
  assert.equal(applicability('keyboard', { hardware: unit('tablet') }).state, 'na');
  // Laptop and unknown: test both (never skip when unsure).
  for (const ff of ['laptop', 'unknown']) {
    assert.equal(applicability('display', { hardware: unit(ff) }).state, 'ready', ff);
    assert.equal(applicability('keyboard', { hardware: unit(ff) }).state, 'ready', ff);
  }
  // Older scans without formFactor still work from the chassis string.
  assert.equal(applicability('display', { hardware: desktop }).state, 'na');
  assert.equal(applicability('keyboard', { hardware: laptop() }).state, 'ready');
});

test('drive health: N/A only when the disk scan worked and found no internal drive', async () => {
  const [, { applicability }] = await load();
  const hw = (storage, disksOk = true) => ({ system: {}, storage, diagnostics: { probes: { disks: { ok: disksOk } } } });
  assert.equal(applicability('drives', { hardware: hw([{ model: 'SSD', removable: false }]) }).state, 'ready');
  assert.equal(applicability('drives', { hardware: hw([]) }).state, 'na');
  assert.equal(applicability('drives', { hardware: hw([{ model: 'USB stick', removable: true }]) }).state, 'na');
  // A timed-out disk probe (seen on HP firmware) must not hide the test.
  assert.equal(applicability('drives', { hardware: hw([], false) }).state, 'ready');
});
