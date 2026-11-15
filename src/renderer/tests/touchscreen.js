import { el } from '../dom.js';
import { resultPanel } from './common.js';

const TARGET_CELL_PX = 110;

export default {
  id: 'touchscreen',
  name: 'Touchscreen',
  description:
    'Swipe a finger across the whole screen until every cell turns green; this finds dead zones, which tapping a few random dots does not. Only touch and pen input count. Press Esc to stop early.',

  mount(root, ctx) {
    let overlay = null;
    let last = ctx.result?.details || {};
    const summary = el('p', { class: 'muted' }, last.cellsTouched ? `Last run: ${last.cellsTouched} cells, max ${last.maxSimultaneousTouches} simultaneous touches.` : 'Not run yet.');

    function start() {
      const w = window.screen.width;
      const h = window.screen.height;
      const cols = Math.max(4, Math.round(w / TARGET_CELL_PX));
      const rows = Math.max(3, Math.round(h / TARGET_CELL_PX));
      const total = cols * rows;
      const hit = new Uint8Array(total);
      let count = 0;
      const active = new Set();
      let maxTouches = 0;
      let mouseWarned = false;

      const cells = Array.from({ length: total }, () => el('div', { class: 'touch-cell' }));
      const hud = el('div', { class: 'touch-hud' });
      const grid = el('div', { class: 'touch-grid', style: { gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` } }, cells);
      overlay = el('div', { class: 'touch-overlay', tabindex: '0' }, grid, hud);

      const updateHud = (msg) => {
        hud.textContent = msg || `${count}/${total} cells · max ${maxTouches} simultaneous touch${maxTouches === 1 ? '' : 'es'} · Esc to stop`;
      };

      const mark = (x, y) => {
        const r = overlay.getBoundingClientRect();
        const c = Math.floor(((x - r.left) / r.width) * cols);
        const rr = Math.floor(((y - r.top) / r.height) * rows);
        if (c < 0 || rr < 0 || c >= cols || rr >= rows) return;
        const i = rr * cols + c;
        if (!hit[i]) {
          hit[i] = 1;
          count++;
          cells[i].classList.add('hit');
          if (count === total) setTimeout(() => finish(true), 400);
        }
      };

      const isTouch = (e) => e.pointerType === 'touch' || e.pointerType === 'pen';
      overlay.addEventListener('pointerdown', (e) => {
        if (!isTouch(e)) {
          if (!mouseWarned) updateHud('Mouse/trackpad input is ignored. Use a finger or pen. (Esc to stop)');
          mouseWarned = true;
          return;
        }
        active.add(e.pointerId);
        maxTouches = Math.max(maxTouches, active.size);
        mark(e.clientX, e.clientY);
        updateHud();
      });
      overlay.addEventListener('pointermove', (e) => {
        if (!isTouch(e) || !active.has(e.pointerId)) return;
        // Coalesced events give every sample of a fast swipe, so cells aren't skipped.
        for (const p of e.getCoalescedEvents?.() || [e]) mark(p.clientX, p.clientY);
        updateHud();
      });
      const lift = (e) => active.delete(e.pointerId);
      overlay.addEventListener('pointerup', lift);
      overlay.addEventListener('pointercancel', lift);
      overlay.addEventListener('keydown', (e) => e.key === 'Escape' && finish(false));
      overlay.addEventListener('fullscreenchange', () => !document.fullscreenElement && finish(false));

      function finish(complete) {
        if (!overlay) return;
        const o = overlay;
        overlay = null;
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        o.remove();
        last = {
          cellsTouched: `${count}/${total}`,
          grid: `${cols}×${rows}`,
          maxSimultaneousTouches: maxTouches,
          complete,
        };
        summary.textContent = complete
          ? `All ${total} cells registered. Max ${maxTouches} simultaneous touches.`
          : `Stopped early: ${count}/${total} cells registered. Untouched cells may be dead zones.`;
        ctx.setResult(complete && ctx.result?.status !== 'fail' ? { status: 'pass', details: last } : { details: last });
      }

      document.body.append(overlay);
      overlay.focus();
      overlay.requestFullscreen?.().catch(() => {});
      updateHud();
    }

    const panel = resultPanel(ctx, {
      getDetails: () => last,
      naLabel: 'N/A (no touchscreen)',
      hint: 'Also put two or more fingers down at once to confirm multi-touch.',
    });
    root.append(el('button', { class: 'btn primary big', onclick: start }, 'Start touch test'), summary, panel.node);
    return () => {
      if (overlay) {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        overlay.remove();
        overlay = null;
      }
      panel.dispose();
    };
  },
};
