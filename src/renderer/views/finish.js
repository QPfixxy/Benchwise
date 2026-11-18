import { el, fill, statusBadge, toast } from '../dom.js';
import { enabledTests, overall, validateAssetTag, inSetup, setProfile } from '../app.js';
import { unitDevices, describeDevice } from '../devices.js';

// Intake: one big tile per check (the session's result for that test).
const TILE = {
  pass: ['ok', '✓'],
  fail: ['missing', '✕'],
  na: ['na', '–'],
  untested: ['warn', '⚠'],
};

function intakeTiles(s, tests, navigate) {
  return el(
    'div',
    { class: 'intake-tiles' },
    tests.map((t) => {
      const r = s.tests[t.id] || {};
      // Threats found but "recorded, not failed" must still look like a finding.
      const [cls, mark] = r.details?.result === 'infected' ? ['missing', '⚠'] : TILE[r.status || 'untested'] || TILE.untested;
      return el(
        'button',
        { class: `notice ${cls} intake-tile`, onclick: () => navigate(`test:${t.id}`), title: 'Open this test' },
        el('strong', {}, `${mark} ${t.name}`),
        el('p', {}, r.details?.summary || r.details?.autoNa || (r.status === 'untested' ? 'Needs your decision: open the test.' : '')),
      );
    }),
  );
}

/** Save location problems, shown before the technician saves. */
function storageWarnings(info, setup) {
  const st = info?.storage;
  if (st?.kind === 'temporary') {
    return el(
      'div',
      { class: 'notice warn' },
      el('strong', {}, 'Reports would be lost'),
      el('p', {}, `Reports are set to save in Windows' temporary setup account (${st.reportsDir}), which is deleted when setup finishes. Start Benchwise from the stick (its LAUNCH launcher), or set a reports folder (e.g. your share) in Settings.`),
    );
  }
  if (setup && st?.kind === 'local') {
    return el(
      'div',
      { class: 'notice warn' },
      el('strong', {}, "Reports are on this unit's own disk"),
      el('p', {}, `They're saved in ${st.reportsDir}, which is erased when this unit is wiped: copy them off first. Running from a writable stick, or with a share set in site.cmd, keeps them safe (and saves them automatically).`),
    );
  }
  return null;
}

/**
 * Intake auto-save: only when nothing is left to decide and the report goes
 * somewhere that outlives the unit (the stick or a share).
 */
function autoSaveReady(ctx, tests, tagError) {
  const s = ctx.state.session;
  const kind = ctx.state.info?.storage?.kind;
  return (
    s.profile === 'intake' &&
    ctx.state.settings?.intakeAutoSave !== false &&
    !s.autoSaved &&
    !tagError &&
    Boolean(ctx.state.hardware) &&
    (kind === 'stick' || kind === 'share') &&
    tests.length > 0 &&
    tests.every((t) => (s.tests[t.id]?.status || 'untested') !== 'untested')
  );
}

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
      const saveBtn = el('button', { class: 'btn primary big', disabled: Boolean(tagError) || saving, onclick: () => save() }, saving ? 'Saving…' : 'Save report');
      if (!saving && autoSaveReady(ctx, tests, tagError)) {
        s.autoSaved = true; // once per unit; saving again by hand still works
        queueMicrotask(() => save(true));
      }
      const intake = s.profile === 'intake';

      fill(body,
        storageWarnings(ctx.state.info, inSetup()),
        intake ? intakeTiles(s, tests, ctx.navigate) : null,
        intake ? null : el(
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

    async function save(auto = false) {
      saving = true;
      draw();
      try {
        const res = await ctx.api.saveAudit({
          assetTag: s.assetTag,
          technician: s.technician,
          notes: s.notes,
          startedAt: s.startedAt,
          profile: s.profile || 'full',
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
            el('h2', {}, auto ? 'Saved automatically ' : 'Report saved ', statusBadge(res.overall)),
            res.fallback
              ? el('p', { class: 'warn-text' }, `Couldn't save to ${res.fallback.failedDir} (${res.fallback.reason}). Saved here instead, so nothing is lost:`)
              : null,
            el('p', { class: 'muted small' }, res.jsonPath),
            res.hub === 'queued' ? el('p', { class: 'small' }, '↑ Queued for the Benchwise server: it sends in the background.') : null,
            res.hub === 'error' ? el('p', { class: 'warn-text small' }, "Couldn't queue for the Benchwise server; the report is saved locally.") : null,
            res.pdfError ? el('p', { class: 'fail-text' }, `PDF could not be generated: ${res.pdfError}. The JSON record was saved.`) : null,
            el(
              'div',
              { class: 'row' },
              res.pdfPath && !res.fallback ? el('button', { class: 'btn', onclick: () => ctx.api.openReport(res.file, 'pdf') }, 'Open PDF') : null,
              res.fallback ? null : el('button', { class: 'btn', onclick: () => ctx.api.revealReport(res.file) }, 'Show in folder'),
              inSetup() ? null : el('button', { class: 'btn primary', onclick: () => ctx.startNewAudit() }, 'Start next unit →'),
            ),
            inSetup() ? doneButtons(ctx) : null,
          ),
        );
        toast(auto ? 'Intake report saved automatically' : 'Report saved', 'success');
      } catch (err) {
        toast(`Save failed: ${err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'error');
      } finally {
        saving = false;
        draw();
      }
    }

    const intakeHead = s.profile === 'intake';
    root.append(
      el(
        'div',
        { class: 'page-head' },
        el(
          'div',
          {},
          el('h1', {}, intakeHead ? 'Intake summary' : 'Finish & Save'),
          el('p', { class: 'muted' }, intakeHead ? 'Lock and malware results for this unit. Save the record, then shut down or go back to Windows setup.' : 'Review results, then save the PDF and JSON record. Click a row to revisit a test.'),
        ),
        intakeHead ? el('button', { class: 'btn', onclick: () => setProfile('full') }, 'Run the full audit →') : null,
      ),
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

/** Windows setup: what to do with the unit once its record is saved. */
function doneButtons(ctx) {
  return el(
    'div',
    { class: 'row done-actions' },
    el(
      'button',
      {
        class: 'btn big',
        onclick: async () => {
          if (!confirm('Shut down this unit now?')) return;
          try {
            await ctx.api.shutdown();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      },
      'Shut down',
    ),
    el('button', { class: 'btn big', onclick: () => ctx.api.quit() }, 'Exit to Windows setup'),
  );
}
