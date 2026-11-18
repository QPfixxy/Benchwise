import { el, toast } from '../dom.js';
import { reloadSettings } from '../app.js';
import { TESTS } from '../tests/index.js';

export default {
  mount(root, ctx) {
    const s = { ...ctx.state.settings, enabledTests: { ...ctx.state.settings.enabledTests } };
    const input = (key, props = {}) =>
      el('input', { value: s[key], oninput: (e) => (s[key] = e.target.value), ...props });

    const reportsDirInput = input('reportsDir', { placeholder: `Default: ${ctx.state.settings.dataDir}/reports` });
    const patternError = el('p', { class: 'fail-text small' });

    const field = (label, control, help) =>
      el('label', { class: 'field block' }, el('span', {}, label), control, help ? el('small', { class: 'muted' }, help) : null);

    async function save() {
      if (s.assetTagPattern) {
        try {
          new RegExp(s.assetTagPattern);
          patternError.textContent = '';
        } catch (err) {
          patternError.textContent = `Invalid pattern: ${err.message}`;
          return;
        }
      }
      try {
        await ctx.api.updateSettings(s);
        await reloadSettings();
        toast('Settings saved', 'success');
      } catch (err) {
        toast(`Could not save: ${err.message}`, 'error');
      }
    }

    root.append(
      el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Settings'), el('p', { class: 'muted small' }, `Stored in ${ctx.state.settings.dataDir}`))),
      el(
        'div',
        { class: 'cards two' },
        el(
          'section',
          { class: 'card' },
          el('h2', {}, 'Station'),
          field('Station name', input('stationName', { placeholder: 'e.g. Bench 3' }), 'Printed on every report.'),
          field('Default technician', input('defaultTechnician'), 'Pre-filled for each new audit.'),
        ),
        el(
          'section',
          { class: 'card' },
          el('h2', {}, 'Asset tag'),
          field('Label', input('assetTagLabel'), 'What your shop calls its internal ID (e.g. "Regency Serial", "Lot #").'),
          field(
            'Required format (regular expression)',
            input('assetTagPattern', { placeholder: 'e.g. \\d{7}-\\d{7}', spellcheck: 'false' }),
            'Leave empty to accept any tag. Matched against the whole tag.',
          ),
          patternError,
        ),
        el(
          'section',
          { class: 'card' },
          el('h2', {}, 'Reports'),
          field(
            'Reports folder',
            el(
              'div',
              { class: 'row' },
              reportsDirInput,
              el(
                'button',
                {
                  class: 'btn ghost',
                  onclick: async (e) => {
                    e.preventDefault();
                    const dir = await ctx.api.chooseDirectory();
                    if (dir) reportsDirInput.value = s.reportsDir = dir;
                  },
                },
                'Choose…',
              ),
            ),
            (ctx.state.info?.platform || '').startsWith('win32')
              ? 'Can be a network share so every bench saves to one place. Use the full \\\\server\\share path, not a mapped drive letter: Benchwise runs as administrator, and Windows hides mapped drives from administrator apps.'
              : 'Can be a network share so every bench saves to one place.',
          ),
        ),
        el(
          'section',
          { class: 'card' },
          el('h2', {}, 'Intake checks (Windows setup)'),
          field(
            'Known tenants file',
            input('knownTenantsFile', { placeholder: `Default: ${ctx.state.settings.dataDir}/KnownTenants.txt`, spellcheck: 'false' }),
            'One "TenantId=Client name" per line, e.g. on your intake share. It names the client on a locked unit. This is client data: keep it on the share or the stick.',
          ),
          el(
            'label',
            { class: 'check' },
            el('input', { type: 'checkbox', checked: s.mdmLockedFails !== false, onchange: (e) => (s.mdmLockedFails = e.target.checked) }),
            'A locked unit fails the audit',
          ),
          el('p', { class: 'muted small' }, 'Turn off to only record locks without failing the unit.'),
          el(
            'label',
            { class: 'check' },
            el('input', { type: 'checkbox', checked: s.malwareFails === true, onchange: (e) => (s.malwareFails = e.target.checked) }),
            'Malware found fails the audit',
          ),
          el('p', { class: 'muted small' }, 'Off: threats are documented in the report but the unit passes this test (it gets wiped and reinstalled anyway).'),
        ),
        el(
          'section',
          { class: 'card' },
          el('h2', {}, 'Tests'),
          el('p', { class: 'muted small' }, 'Disable tests that never apply at this station (e.g. touchscreen on a desktop bench).'),
          TESTS.map((t) =>
            el(
              'label',
              { class: 'check' },
              el('input', { type: 'checkbox', checked: s.enabledTests[t.id] !== false, onchange: (e) => (s.enabledTests[t.id] = e.target.checked) }),
              t.name,
            ),
          ),
        ),
      ),
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: save }, 'Save settings')),
    );
  },
};
