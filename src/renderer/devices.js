// Classifies camera/mic/speaker devices by label so tests default to the
// unit's own hardware, and phones, headsets and virtual devices never get
// recorded as part of the machine being audited.
//
//   builtin  - part of the unit (FaceTime HD, Integrated Camera, Realtek array…)
//   external - plugged in (USB webcam, headset, AirPods, Bluetooth)
//   phone    - Continuity Camera / phone mic (iPhone, iPad, Desk View)
//   virtual  - software devices (OBS, Teams, Zoom, BlackHole, VB-Cable…)
//   unknown  - can't tell; treated as possibly built-in

const VIRTUAL =
  /virtual|\bobs\b|snap camera|manycam|xsplit|droidcam|epoccam|\bcamo\b|nvidia broadcast|teams|zoom|blackhole|soundflower|loopback|vb-?audio|cable (in|out)put|voicemeeter|steam streaming|krisp|aggregate device|multi-output|screen capture|ndi/i;
const PHONE = /iphone|ipad|desk view|continuity|android|pixel|galaxy/i;
const EXTERNAL =
  /logitech|\bc9\d\d\b|\bbrio\b|razer|elgato|anker|jabra|\bpoly\b|plantronics|airpods|beats|bose|sony|sennheiser|hyperx|steelseries|corsair|yeti|\brode\b|shure|headset|headphone|earbud|\bbuds\b|bluetooth|hands-?free|usb audio|usb (pnp )?sound|display audio|hdmi|displayport|nvidia high definition|amd high definition|lg (ultra|monitor)|dell (u|p|s)\d|monitor|dock/i;
// Names that explicitly say "part of the machine" (beats the USB-ID rule below:
// laptop webcams are USB internally, e.g. "Integrated Camera (04f2:b6dd)").
const EXPLICIT_BUILTIN = /facetime|built-?in|integrated|internal|macbook|imac|truevision|easycamera|user[- ]facing|front camera|ir camera|\bhd camera\b|hd (uvc )?web ?cam/i;
const BUILTIN =
  /laptop|notebook|realtek|conexant|synaptics|cirrus|intel.*(smart sound|sst|audio)|microphone array|speakers? \((realtek|conexant|intel|high definition audio)|smart sound/i;
// Chromium appends "(vendor:product)" to USB-attached devices.
const USB_ID = /\([0-9a-f]{4}:[0-9a-f]{4}\)/i;

export function classifyDevice(label = '') {
  const l = String(label);
  if (!l.trim()) return 'unknown';
  if (VIRTUAL.test(l)) return 'virtual';
  if (PHONE.test(l)) return 'phone';
  if (EXPLICIT_BUILTIN.test(l)) return 'builtin';
  if (EXTERNAL.test(l) || USB_ID.test(l)) return 'external'; // e.g. dock "Realtek USB2.0 Audio (0bda:498a)"
  if (BUILTIN.test(l)) return 'builtin';
  return 'unknown';
}

const RANK = { builtin: 0, unknown: 1, external: 2, phone: 3, virtual: 4 };

/** Sort so the unit's own device comes first. Stable for equal ranks. */
export function rankDevices(devices) {
  return devices
    .map((d, i) => ({ d, i, r: RANK[classifyDevice(d.label)] }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.d);
}

/** Devices that may belong to the unit (excludes phone + virtual). */
export function unitDevices(devices) {
  return devices.filter((d) => !['phone', 'virtual'].includes(classifyDevice(d.label)));
}

export const CLASS_NOTE = {
  builtin: 'built-in',
  external: 'external',
  phone: 'phone: not part of this unit',
  virtual: 'virtual: not hardware',
  unknown: '',
};

export function describeDevice(label) {
  const cls = classifyDevice(label);
  const note = CLASS_NOTE[cls];
  // macOS labels already end in "(Built-in)"; don't say it twice.
  if (!note || (cls === 'builtin' && /built-?in/i.test(label))) return label;
  return `${label} (${note})`;
}
