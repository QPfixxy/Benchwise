// Keyboard layout as data, keyed by KeyboardEvent.code. Positions are in key
// units (u); 1u = one alpha key. Generated rather than hand-written HTML.

function row(y, keys, x = 0) {
  const out = [];
  for (const [code, label, w = 1] of keys) {
    if (code) out.push({ code, label, x, y, w, h: 1 });
    x += w;
  }
  return out;
}

const letters = (s) => [...s].map((c) => [`Key${c}`, c]);

export function buildLayout({ mac = false } = {}) {
  const meta = mac ? '⌘ Cmd' : 'Win';
  const alt = mac ? '⌥ Opt' : 'Alt';
  const main = [
    ...row(0, [
      ['Escape', 'Esc'],
      [null, null, 1],
      ...[1, 2, 3, 4].map((n) => [`F${n}`, `F${n}`]),
      [null, null, 0.5],
      ...[5, 6, 7, 8].map((n) => [`F${n}`, `F${n}`]),
      [null, null, 0.5],
      ...[9, 10, 11, 12].map((n) => [`F${n}`, `F${n}`]),
    ]),
    ...row(1, [
      ['Backquote', '`'],
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((n) => [`Digit${n}`, String(n)]),
      ['Minus', '-'],
      ['Equal', '='],
      ['Backspace', mac ? 'Delete' : 'Backspace', 2],
    ]),
    ...row(2, [['Tab', 'Tab', 1.5], ...letters('QWERTYUIOP'), ['BracketLeft', '['], ['BracketRight', ']'], ['Backslash', '\\', 1.5]]),
    ...row(3, [['CapsLock', 'Caps', 1.75], ...letters('ASDFGHJKL'), ['Semicolon', ';'], ['Quote', "'"], ['Enter', 'Enter', 2.25]]),
    ...row(4, [['ShiftLeft', 'Shift', 2.25], ...letters('ZXCVBNM'), ['Comma', ','], ['Period', '.'], ['Slash', '/'], ['ShiftRight', 'Shift', 2.75]]),
    ...row(5, [
      ['ControlLeft', 'Ctrl', 1.25],
      ...(mac
        ? [['AltLeft', alt, 1.25], ['MetaLeft', meta, 1.25]]
        : [['MetaLeft', meta, 1.25], ['AltLeft', alt, 1.25]]),
      ['Space', '', 6.25],
      ...(mac
        ? [['MetaRight', meta, 1.25], ['AltRight', alt, 1.25]]
        : [['AltRight', alt, 1.25], ['MetaRight', meta, 1.25]]),
      ['ContextMenu', 'Menu', 1.25],
      ['ControlRight', 'Ctrl', 1.25],
    ]),
  ];

  const nav = [
    ...row(0, [['PrintScreen', 'PrtSc'], ['ScrollLock', 'ScrLk'], ['Pause', 'Pause']]),
    ...row(1, [['Insert', 'Ins'], ['Home', 'Home'], ['PageUp', 'PgUp']]),
    ...row(2, [['Delete', 'Del'], ['End', 'End'], ['PageDown', 'PgDn']]),
    ...row(4, [[null, null], ['ArrowUp', '↑']]),
    ...row(5, [['ArrowLeft', '←'], ['ArrowDown', '↓'], ['ArrowRight', '→']]),
  ];

  const numpad = [
    ...row(1, [['NumLock', 'Num'], ['NumpadDivide', '/'], ['NumpadMultiply', '*'], ['NumpadSubtract', '-']]),
    ...row(2, [['Numpad7', '7'], ['Numpad8', '8'], ['Numpad9', '9']]),
    { code: 'NumpadAdd', label: '+', x: 3, y: 2, w: 1, h: 2 },
    ...row(3, [['Numpad4', '4'], ['Numpad5', '5'], ['Numpad6', '6']]),
    ...row(4, [['Numpad1', '1'], ['Numpad2', '2'], ['Numpad3', '3']]),
    { code: 'NumpadEnter', label: 'Ent', x: 3, y: 4, w: 1, h: 2 },
    ...row(5, [['Numpad0', '0', 2], ['NumpadDecimal', '.']]),
  ];

  return {
    sections: [
      { id: 'main', width: 15, keys: main },
      { id: 'nav', width: 3, keys: nav },
      { id: 'numpad', width: 4, keys: numpad },
    ],
  };
}

/** Presets: which sections are shown and which keys are excluded up front. */
export const PRESETS = {
  full: { label: 'Full-size', sections: ['main', 'nav', 'numpad'], exclude: [] },
  tkl: { label: 'Tenkeyless', sections: ['main', 'nav'], exclude: [] },
  laptop: {
    label: 'Laptop (Windows/Linux)',
    sections: ['main', 'nav'],
    exclude: ['ScrollLock', 'Pause', 'Insert', 'MetaRight', 'ContextMenu', 'PageUp', 'PageDown', 'Home', 'End'],
  },
  mac: {
    label: 'Mac laptop',
    sections: ['main', 'nav'],
    exclude: [
      'PrintScreen', 'ScrollLock', 'Pause', 'Insert', 'Home', 'PageUp', 'Delete', 'End', 'PageDown',
      'ContextMenu', 'ControlRight', 'F13',
    ],
  },
};

export function defaultPreset({ mac, chassisType, formFactor }) {
  const portable = formFactor
    ? formFactor === 'laptop' || formFactor === 'tablet'
    : /laptop|notebook|portable|convertible|detachable|tablet|sub ?notebook|hand held/i.test(chassisType || '');
  if (mac) return portable ? 'mac' : 'full';
  return portable ? 'laptop' : 'full';
}
