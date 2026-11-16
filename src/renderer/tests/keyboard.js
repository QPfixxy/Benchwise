import { el, fill } from '../dom.js';
import { resultPanel } from './common.js';
import { buildLayout, PRESETS, defaultPreset } from './keyboard-layout.js';

export default {
  id: 'keyboard',
  name: 'Keyboard',
  description:
    'Press every key. Keys turn green when registered and glow while held (a key that stays lit is stuck). Click a key to exclude it if this keyboard does not have it.',

  mount(root, ctx) {
    const mac = (ctx.state.info?.platform || '').startsWith('darwin');
    const layout = buildLayout({ mac });
    const allKeys = layout.sections.flatMap((s) => s.keys.map((k) => ({ ...k, section: s.id })));
    const byCode = new Map(allKeys.map((k) => [k.code, k]));

    const saved = ctx.result?.details?._state;
    let preset = saved?.preset || defaultPreset({ mac, chassisType: ctx.state.hardware?.system?.chassisType, formFactor: ctx.state.hardware?.system?.formFactor });
    const registered = new Set(saved?.registered || []);
    const excluded = new Set(saved?.excluded || PRESETS[preset].exclude);
    let sections = new Set(saved?.sections || PRESETS[preset].sections);
    const held = new Set();
    const extra = new Set(saved?.extra || []); // codes not on the drawn layout (media keys etc.)
    const keyEls = new Map();

    const counter = el('div', { class: 'kb-counter' });
    const extraList = el('p', { class: 'muted small' });
    const board = el('div', { class: 'keyboard' });

    const active = () => allKeys.filter((k) => sections.has(k.section) && !excluded.has(k.code));

    function details() {
      const keys = active();
      const done = keys.filter((k) => registered.has(k.code));
      const missing = keys.filter((k) => !registered.has(k.code)).map((k) => k.label || k.code);
      return {
        layout: PRESETS[preset]?.label || 'Custom',
        keysRegistered: `${done.length}/${keys.length}`,
        missing: missing.slice(0, 40),
        stuck: [...held].map((c) => byCode.get(c)?.label || c),
        excluded: [...excluded].filter((c) => sections.has(byCode.get(c)?.section)),
        otherKeys: [...extra],
        _state: { preset, registered: [...registered], excluded: [...excluded], sections: [...sections], extra: [...extra] },
      };
    }

    function update() {
      const keys = active();
      const done = keys.filter((k) => registered.has(k.code)).length;
      fill(counter, 
        el('strong', {}, `${done} / ${keys.length}`),
        ' keys registered',
        held.size ? el('span', { class: 'warn-text' }, ` · ${held.size} held`) : null,
      );
      for (const [code, node] of keyEls) {
        node.classList.toggle('registered', registered.has(code));
        node.classList.toggle('held', held.has(code));
        node.classList.toggle('excluded', excluded.has(code));
      }
      extraList.textContent = extra.size ? `Other keys detected: ${[...extra].join(', ')}` : '';
      const status = ctx.result?.status;
      // Auto-pass when everything registered; never overwrite an operator's Fail.
      if (keys.length && done === keys.length && !held.size && status !== 'fail') {
        ctx.setResult({ status: 'pass', details: details() });
      } else if (status === 'untested' || !status) {
        ctx.setResult({ details: details() });
      }
    }

    function draw() {
      keyEls.clear();
      fill(board, 
        ...layout.sections
          .filter((s) => sections.has(s.id))
          .map((s) =>
            el(
              'div',
              { class: `kb-section kb-${s.id}`, style: { gridTemplateColumns: `repeat(${s.width * 4}, var(--kq))` } },
              s.keys.map((k) => {
                const node = el(
                  'button',
                  {
                    class: 'key',
                    title: `${k.code} (click to ${excluded.has(k.code) ? 'include' : 'exclude'})`,
                    tabindex: '-1',
                    style: { gridColumn: `${k.x * 4 + 1} / span ${k.w * 4}`, gridRow: `${k.y + 1} / span ${k.h}` },
                    onclick: () => {
                      excluded.has(k.code) ? excluded.delete(k.code) : excluded.add(k.code);
                      preset = 'custom';
                      presetSelect.value = 'custom';
                      update();
                    },
                  },
                  k.label,
                );
                keyEls.set(k.code, node);
                return node;
              }),
            ),
          ),
      );
      update();
    }

    const presetSelect = el(
      'select',
      {
        onchange: (e) => {
          preset = e.target.value;
          if (PRESETS[preset]) {
            sections = new Set(PRESETS[preset].sections);
            excluded.clear();
            PRESETS[preset].exclude.forEach((c) => excluded.add(c));
          }
          draw();
        },
      },
      Object.entries(PRESETS).map(([id, p]) => el('option', { value: id, selected: id === preset }, p.label)),
      el('option', { value: 'custom', selected: preset === 'custom' }, 'Custom'),
    );

    const onKey = (k) => {
      if (k.type === 'blur') {
        held.clear(); // OS took focus (e.g. Win key, Cmd+Tab); releases never arrive
        return update();
      }
      if (!k.code) return;
      if (k.type === 'down') {
        held.add(k.code);
        if (byCode.has(k.code)) registered.add(k.code);
        else extra.add(k.code);
      } else {
        held.delete(k.code);
      }
      update();
    };

    const offKey = ctx.api.onKey(onKey);
    ctx.api.captureKeyboard(true);

    const panel = resultPanel(ctx, {
      getDetails: details,
      naLabel: 'N/A (no keyboard)',
      hint: 'Fn and some OS-reserved keys (Win, PrintScreen on Windows, Cmd+Tab) never reach applications; exclude them and verify by hand.',
    });

    root.append(
      el(
        'div',
        { class: 'row between' },
        el(
          'div',
          { class: 'row' },
          el('label', { class: 'field inline' }, el('span', {}, 'Layout'), presetSelect),
          el(
            'button',
            {
              class: 'btn ghost',
              onclick: () => {
                registered.clear();
                held.clear();
                extra.clear();
                if (ctx.result?.status === 'pass') ctx.setResult({ status: 'untested' });
                update();
              },
            },
            'Reset',
          ),
        ),
        counter,
      ),
      el('div', { class: 'kb-capture-note muted small' }, 'Keyboard capture is on: app shortcuts are disabled while this test is open.'),
      board,
      extraList,
      panel.node,
    );
    draw();

    return () => {
      ctx.api.captureKeyboard(false);
      offKey();
      panel.dispose();
    };
  },
};
