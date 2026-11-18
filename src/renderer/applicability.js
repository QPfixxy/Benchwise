import { unitDevices } from './devices.js';

// Decides, per test, whether it applies to this unit:
//
//   ready    - run it
//   na       - the unit doesn't have this hardware and isn't expected to
//              (auto-recorded as N/A with the reason; operator can override)
//   missing  - the unit SHOULD have it (e.g. a laptop camera) but nothing was
//              detected. Never auto-skipped: a dead module is a failure.
//
// `warning` adds context without changing the state (e.g. lid closed).

const PORTABLE = /laptop|notebook|portable|convertible|detachable|tablet|sub ?notebook|hand ?held/i;
const ALL_IN_ONE = /all[- ]?in[- ]?one|imac/i;
const DESKTOP = /desktop|tower|pizza|lunch ?box|space-saving|sealed-case|mini pc|stick pc|server|rack|blade/i;

/** Form factor from the scan; the regex fallback covers scans without one. */
function formFactorOf(hw) {
  const sys = hw.system || {};
  if (sys.formFactor) return sys.formFactor;
  const model = `${sys.model || ''} ${sys.version || ''}`;
  if (PORTABLE.test(sys.chassisType || '') || /macbook/i.test(model) || hw.battery?.present) return 'laptop';
  if (ALL_IN_ONE.test(sys.chassisType || '') || ALL_IN_ONE.test(model)) return 'all-in-one';
  if (DESKTOP.test(sys.chassisType || '')) return /server|rack|blade/i.test(sys.chassisType) ? 'server' : 'desktop';
  return 'unknown';
}

export function unitProfile(hw = {}) {
  const formFactor = formFactorOf(hw);
  const portable = formFactor === 'laptop' || formFactor === 'tablet';
  const allInOne = formFactor === 'all-in-one';
  return {
    formFactor,
    portable,
    allInOne,
    // Desktops and servers: screen and keyboard are peripherals, not the unit.
    separatePeripherals: formFactor === 'desktop' || formFactor === 'server',
    expectsBuiltInAV: portable || allInOne, // camera, mic, speakers, screen
    lidClosed: hw.capabilities?.lidClosed === true,
  };
}

const UNIT_NAME = { desktop: 'Desktop', server: 'Server', 'all-in-one': 'All-in-one', tablet: 'Tablet' };

const LID_HINT = 'The lid is closed, so the built-in camera, microphone, keyboard and screen may be unavailable. Open the lid and rescan.';

function avRule(kind, devices, p) {
  const present = unitDevices(devices || []);
  const name = { camera: 'camera', microphone: 'microphone', speakers: 'speaker output' }[kind];
  if (present.length) return { state: 'ready', warning: p.lidClosed && p.portable && kind !== 'speakers' ? LID_HINT : null };
  if (p.expectsBuiltInAV) {
    return {
      state: 'missing',
      reason: p.lidClosed
        ? `No built-in ${name} detected. ${LID_HINT}`
        : `No ${name} detected, but this type of unit normally has one. The module may be dead, disconnected or disabled in BIOS/OS. Mark Fail if it should be there.`,
    };
  }
  return { state: 'na', reason: `No ${name} detected; desktop units usually don't have one.` };
}

/**
 * @param {string} testId
 * @param {{hardware, media, maxTouchPoints}} ctx
 */
export function applicability(testId, { hardware, media = {}, maxTouchPoints = 0 } = {}) {
  if (!hardware) return { state: 'ready' }; // not scanned yet: don't guess
  const p = unitProfile(hardware);
  switch (testId) {
    case 'camera':
      return avRule('camera', media.cameras, p);
    case 'microphone':
      return avRule('microphone', media.microphones, p);
    case 'speakers':
      return avRule('speakers', media.speakers, p);
    case 'touchscreen': {
      const touch = hardware.capabilities?.touch;
      if (touch === 'available' || maxTouchPoints > 0) return { state: 'ready' };
      // A dead digitizer usually still enumerates as a touch device, so "no
      // touch hardware" reliably means this isn't a touch model.
      return { state: 'na', reason: 'The OS reports no touch hardware: this is not a touchscreen model.' };
    }
    case 'display':
      if (p.separatePeripherals) {
        return { state: 'na', reason: `${UNIT_NAME[p.formFactor]} unit: the monitor is a separate peripheral, not part of this unit.` };
      }
      return { state: 'ready', warning: p.lidClosed && p.portable ? 'The lid is closed: you are testing an external monitor, not the built-in panel.' : null };
    case 'cpu':
    case 'memory':
      return {
        state: 'ready',
        warning:
          hardware.battery?.present && !hardware.battery?.acConnected
            ? 'Running on battery: plug in the charger. Under stress, battery power throttles the CPU and drains fast, which skews the result.'
            : null,
      };
    case 'keyboard':
      if (p.separatePeripherals || p.allInOne) {
        return { state: 'na', reason: `${UNIT_NAME[p.formFactor]} unit: the keyboard is a separate peripheral, not part of this unit.` };
      }
      if (p.formFactor === 'tablet') {
        return { state: 'na', reason: 'Tablet: no built-in keyboard (a keyboard cover is an accessory).' };
      }
      return { state: 'ready', warning: p.lidClosed && p.portable ? 'The lid is closed: keys typed now come from an external keyboard, not the built-in one.' : null };
    case 'malware': {
      // Scans the installed Windows during setup (OOBE), before the unit is
      // wiped and reinstalled: that's where the intake process runs it.
      const mode = hardware.environment?.mode;
      if (mode === 'oobe') return { state: 'ready' };
      if (!['audit', 'windows', 'winpe'].includes(mode)) return { state: 'na', reason: 'Windows only: the malware scan uses Microsoft Defender on the installed Windows.' };
      return { state: 'na', reason: 'Run the malware scan during Windows setup (OOBE, Shift+F10), as part of intake. It switches Defender to audit-only mode, which is not wanted on a finished installation.' };
    }
    case 'mdm': {
      // The Autopilot lock is only trustworthy during Windows setup, when
      // Windows downloads its Autopilot profile from Microsoft.
      const mode = hardware.environment?.mode;
      if (mode === 'oobe') return { state: 'ready' };
      if (!['audit', 'windows', 'winpe'].includes(mode)) {
        return { state: 'na', reason: 'Windows only: the Autopilot lock check runs during Windows setup (OOBE).' };
      }
      if (mode === 'audit') {
        return { state: 'na', reason: 'Audit mode: the lock check is only proven during Windows setup (OOBE). Run it from the setup screens (Shift+F10) for a result you can trust.' };
      }
      if (mode === 'windows') {
        return { state: 'na', reason: 'Windows setup is already finished. Run this check during Windows setup (OOBE, Shift+F10), when the unit asks Microsoft for its Autopilot profile.' };
      }
      return { state: 'na', reason: 'Run this check during Windows setup (OOBE, Shift+F10).' };
    }
    case 'drives': {
      // Only trust "no drive" if the disk scan itself worked (a timed-out
      // probe also gives an empty list).
      const scanned = hardware.diagnostics?.probes?.disks?.ok !== false;
      const internal = (hardware.storage || []).filter((d) => !d.removable);
      if (scanned && !internal.length) {
        return { state: 'na', reason: 'No internal drive detected: the drive has been removed. If one is fitted, it is not being seen; check that it is seated.' };
      }
      return { state: 'ready' };
    }
    default:
      return { state: 'ready' };
  }
}
