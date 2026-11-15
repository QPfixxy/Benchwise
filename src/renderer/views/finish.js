import { el, fill, statusBadge, toast } from '../dom.js';
import { enabledTests, overall, validateAssetTag } from '../app.js';
import { unitDevices, describeDevice } from '../devices.js';

const summarize = (details = {}) =>
  Object.entries(details)
    .filter(([k, v]) => !k.startsWith('_') && v !== null && v !== '' && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' · ');

export default {
  mount(root, ctx) {
    const s = ctx.state.session;
    const body = el('div', {});
    const resultBox = el('div', {});
    let saving = false;
    let lastKey = null;

    const draw = () => {
      const tests = enabledTests();
      const untested = tests.filter((t) => (s.tests[t.id]?.status || 'untested') === 'untested');
      const tagError = validateAssetTag(s.assetTag);
      // Only rebuild when something shown here changed; a running stress test
      // emits every second and rebuilding would steal focus from the notes box.
      const key = JSON.stringify([tests.map((t) => [t.id, s.tests[t.id]?.status, summarize(s.tests[t.id]?.details), s.tests[t.id]?.notes]), tagError, saving, Boolean(ctx.state.hardware)]);
      if (key === lastKey) return;
      lastKey = key;
      const saveBtn = el('button', { class: 'btn primary big', disabled: Boolean(tagError) || saving, onclick: save }, saving ? 'Saving…' : 'Save report');

      fill(body, 
        el(
          'table',
          { class: 'grid tests-summary' },
          el('thead', {}, el('tr', {}, ['Test', 'Result', 'Details', 'Notes'].map((h) => el('th', {}, h)))),
          el(
            'tbody',
            {},
            tests.map((t) => {
              const r = s.tests[t.id] || {};
              return el(
                'tr',
                { class: 'clickable', onclick: () => ctx.navigate(`test:${t.id}`) },
                el('td', {}, t.name),
                el('td', {}, statusBadge(r.status || 'untested')),
                el('td', { class: 'small' }, summarize(r.details)),
                el('td', { class: 'small' }, r.notes || ''),
              );
            }),
          ),
        ),
        el(
          'label',
          { class: 'field block' },
          el('span', {}, 'Audit notes (cosmetic grade, missing parts, etc.)'),
          el('textarea', { rows: 3, value: s.notes, oninput: (e) => (s.notes = e.target.value) }),
        ),
        tagError ? el('p', { class: 'fail-text' }, `${ctx.state.settings.assetTagLabel}: ${tagError}`) : null,
        untested.length
          ? el('p', { class: 'warn-text' }, `${untested.length} test(s) not run: ${untested.map((t) => t.name).join(', ')}. The report will be marked Incomplete.`)
          : null,
        !ctx.state.hardware ? el('p', { class: 'warn-text' }, 'Hardware scan has not finished yet; saving will wait for it.') : null,
        el('div', { class: 'row' }, el('span', {}, 'Overall: '), statusBadge(overall()), saveBtn),
      );
    };

    async function save() {
      saving = true;
      draw();
      try {
        const res = await ctx.api.saveAudit({
          assetTag: s.assetTag,
          technician: s.technician,
          notes: s.notes,
          startedAt: s.startedAt,
          tests: s.tests,
          // Only devices that can belong to the unit (no phones / virtual devices).
          media: Object.fromEntries(
            Object.entries(ctx.state.media).map(([k, list]) => [k, unitDevices(list).map((d) => describeDevice(d.label))]),
          ),
        });
        fill(resultBox, 
          el(
            'div',
            { class: 'card saved' },
            el('h2', {}, 'Report saved ', statusBadge(res.overall)),
            el('p', { class: 'muted small' }, res.jsonPath),
            res.pdfError ? el('p', { class: 'fail-text' }, `PDF could not be generated: ${res.pdfError}. The JSON record was saved.`) : null,
            el(
              'div',
              { class: 'row' },
              res.pdfPath ? el('button', { class: 'btn', onclick: () => ctx.api.openReport(res.file, 'pdf') }, 'Open PDF') : null,
              el('button', { class: 'btn', onclick: () => ctx.api.revealReport(res.file) }, 'Show in folder'),
              el('button', { class: 'btn primary', onclick: () => ctx.startNewAudit() }, 'Start next unit →'),
            ),
          ),
        );
        toast('Report saved', 'success');
      } catch (err) {
        toast(`Save failed: ${err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'error');
      } finally {
        saving = false;
        draw();
      }
    }

    root.append(
      el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Finish & Save'), el('p', { class: 'muted' }, 'Review results, then save the PDF and JSON record. Click a row to revisit a test.'))),
      body,
      resultBox,
    );
    draw();
    // Asset tag is typed in the header; redraw so the Save button enables.
    const tagInput = document.getElementById('assetTagInput');
    tagInput?.addEventListener('input', draw);
    const off = ctx.onChange(draw);
    return () => {
      tagInput?.removeEventListener('input', draw);
      off();
    };
  },
};
