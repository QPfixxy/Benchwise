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

export function unitProfile(hw = {}) {
  const chassis = hw.system?.chassisType || '';
  const model = `${hw.system?.model || ''} ${hw.system?.version || ''}`;
  const portable = PORTABLE.test(chassis) || /macbook/i.test(model) || Boolean(hw.battery?.present);
  const allInOne = ALL_IN_ONE.test(chassis) || ALL_IN_ONE.test(model);
  return {
    portable,
    allInOne,
    expectsBuiltInAV: portable || allInOne, // camera, mic, speakers, screen
    lidClosed: hw.capabilities?.lidClosed === true,
  };
}

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
      return { state: 'ready', warning: p.lidClosed && p.portable ? 'The lid is closed: keys typed now come from an external keyboard, not the built-in one.' : null };
    default:
      return { state: 'ready' };
  }
}
