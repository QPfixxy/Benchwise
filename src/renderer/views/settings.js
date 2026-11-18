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

    const hub = hubCard(ctx, input, field);
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
          el(
            'label',
            { class: 'check' },
            el('input', { type: 'checkbox', checked: s.assetTagRequired === true, onchange: (e) => (s.assetTagRequired = e.target.checked) }),
            'Require an asset tag to save',
          ),
          el('p', { class: 'muted small' }, 'Off by default: records are identified by the manufacturer serial.'),
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
          el(
            'label',
            { class: 'check' },
            el('input', { type: 'checkbox', checked: s.intakeAutoSave !== false, onchange: (e) => (s.intakeAutoSave = e.target.checked) }),
            'Save intake reports automatically',
          ),
          el('p', { class: 'muted small' }, 'Only when both checks have a result (no ghost profile or unconfirmed result waiting for you) and the report goes to the stick or a share.'),
        ),
        hub.node,
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
    return hub.off; // stop listening for Hub updates when leaving Settings
  },
};

/** Benchwise Hub: where saved reports are sent (central records). */
function hubCard(ctx, input, field) {
  const status = el('p', { class: 'muted small' }, '');
  const testLine = el('p', { class: 'small' });
  const refresh = async () => {
    try {
      const st = await ctx.api.hub.status();
      status.textContent = !st.configured
        ? 'Not set up: reports are only saved locally.'
        : [
            st.fromSiteCmd ? "Set by the stick's site.cmd." : null,
            `${st.pending} waiting to send`,
            st.failed ? `${st.failed} refused (kept on the stick)` : null,
            st.sentAt ? `last sent ${new Date(st.sentAt).toLocaleString()}` : null,
            st.error ? `Problem: ${st.error}` : null,
          ]
            .filter(Boolean)
            .join(' · ');
    } catch {
      /* not critical */
    }
  };
  refresh();
  const off = ctx.api.hub.onChange(refresh);
  const node = el(
    'section',
    { class: 'card' },
    el('h2', {}, 'Benchwise Hub'),
    el('p', { class: 'muted small' }, 'Saved reports are queued and sent to your central Hub in the background. Testing never waits for the network.'),
    field('Hub address', input('hubUrl', { placeholder: 'https://hub.example.local', spellcheck: 'false' })),
    field('Station key', input('hubKey', { type: 'password', placeholder: 'bws_…', autocomplete: 'off', spellcheck: 'false' }), 'From the Hub: Administration → Stations → Enroll.'),
    field(
      'Certificate fingerprint (SHA-256)',
      input('hubFingerprint', { placeholder: 'Only for a self-signed Hub certificate', spellcheck: 'false' }),
      'The installer prints it. Leave empty if the Hub uses a certificate your PCs already trust.',
    ),
    el(
      'div',
      { class: 'row' },
      el(
        'button',
        {
          class: 'btn ghost',
          onclick: async (e) => {
            e.preventDefault();
            testLine.textContent = 'Testing… (save first if you changed the fields)';
            const r = await ctx.api.hub.test();
            testLine.textContent = r.message;
            testLine.className = `small ${r.ok ? 'pass-text' : 'fail-text'}`;
            refresh();
          },
        },
        'Test connection',
      ),
      el('button', { class: 'btn ghost', onclick: (e) => (e.preventDefault(), ctx.api.hub.retry()) }, 'Send now'),
    ),
    testLine,
    status,
  );
  return { node, off };
}
