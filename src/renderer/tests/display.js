import { el } from '../dom.js';
import { resultPanel } from './common.js';

const PATTERNS = [
  { name: 'Black', hint: 'Look for stuck (lit) pixels and backlight bleed at the edges.', cls: 'p-black' },
  { name: 'White', hint: 'Look for dead (dark) pixels, dust, pressure marks.', cls: 'p-white' },
  { name: 'Red', hint: 'Look for pixels that are not red.', cls: 'p-red' },
  { name: 'Green', hint: 'Look for pixels that are not green.', cls: 'p-green' },
  { name: 'Blue', hint: 'Look for pixels that are not blue.', cls: 'p-blue' },
  { name: 'Gray 50%', hint: 'Look for uneven brightness (clouding) and tint.', cls: 'p-gray' },
  { name: 'Gradient', hint: 'Look for banding or color steps.', cls: 'p-gradient' },
];

export default {
  id: 'display',
  name: 'Display',
  description:
    'Show full-screen solid colors to find dead or stuck pixels, backlight bleed, clouding and banding. Click, Space or → to advance; ← to go back; Esc to exit.',

  mount(root, ctx) {
    let viewed = new Set(ctx.result?.details?._viewed || []);
    let overlay = null;
    const summary = el('p', { class: 'muted' });

    const refresh = () => (summary.textContent = `${viewed.size} of ${PATTERNS.length} patterns viewed.`);

    function start() {
      let i = 0;
      const label = el('div', { class: 'pattern-label' });
      overlay = el('div', { class: 'pattern-overlay', tabindex: '0' }, label);
      const show = () => {
        const p = PATTERNS[i];
        overlay.className = `pattern-overlay ${p.cls}`;
        label.textContent = `${i + 1}/${PATTERNS.length} · ${p.name} — ${p.hint}`;
        label.classList.remove('fade');
        void label.offsetWidth; // restart animation
        label.classList.add('fade');
        viewed.add(p.name);
        refresh();
      };
      const step = (d) => {
        i += d;
        if (i >= PATTERNS.length) return end();
        i = Math.max(0, i);
        show();
      };
      overlay.addEventListener('click', () => step(1));
      overlay.addEventListener('contextmenu', (e) => (e.preventDefault(), step(-1)));
      overlay.addEventListener('keydown', (e) => {
        if ([' ', 'ArrowRight', 'Enter'].includes(e.key)) step(1);
        else if (e.key === 'ArrowLeft') step(-1);
        else if (e.key === 'Escape') end();
        e.preventDefault();
      });
      document.body.append(overlay);
      overlay.focus();
      overlay.requestFullscreen?.().catch(() => {});
      overlay.addEventListener('fullscreenchange', () => {
        if (!document.fullscreenElement) end();
      });
      show();
    }

    function end() {
      if (!overlay) return;
      const o = overlay;
      overlay = null;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      o.remove();
      ctx.setResult({ details: { ...ctx.result?.details, patternsViewed: `${viewed.size}/${PATTERNS.length}`, _viewed: [...viewed] } });
    }

    const panel = resultPanel(ctx, {
      getDetails: () => ({ patternsViewed: `${viewed.size}/${PATTERNS.length}`, _viewed: [...viewed] }),
      naLabel: 'N/A (no display)',
    });
    refresh();
    root.append(
      el('button', { class: 'btn primary big', onclick: start }, 'Start full-screen test'),
      summary,
      el('p', { class: 'muted small' }, 'Tip: right-click goes back a pattern. Clean the screen first so dust is not mistaken for a dead pixel.'),
      panel.node,
    );
    return () => {
      end();
      panel.dispose();
    };
  },
};
