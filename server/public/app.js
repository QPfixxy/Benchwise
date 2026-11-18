// Benchwise Server web interface. Uses the same JSON API as integrations.
// All data is inserted as text (never HTML), so nothing in a record can
// inject markup.

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'value') n.value = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}
const fill = (node, ...kids) => {
  node.replaceChildren();
  for (const c of kids.flat(Infinity)) if (c) node.append(c instanceof Node ? c : String(c));
  return node;
};

let toastTimer;
function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 3500);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-benchwise': '1' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 401 && path !== '/session') {
    me = null;
    location.hash = '#/login';
    throw new Error('Please sign in.');
  }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const badge = (v) => (v ? el('span', { class: `badge ${String(v).toLowerCase()}` }, v) : el('span', { class: 'muted' }, '—'));
const kv = (rows) => el('dl', { class: 'kv' }, rows.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));

let me = null;

// ------------------------------------------------------------------ pages

function loginPage(view) {
  const user = el('input', { autocomplete: 'username', required: true });
  const pass = el('input', { type: 'password', autocomplete: 'current-password', required: true });
  const err = el('p', { class: 'muted' });
  const form = el(
    'form',
    {
      class: 'card login',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('/session', { method: 'POST', body: { username: user.value.trim(), password: pass.value } });
          me = await api('/me');
          location.hash = '#/';
        } catch (x) {
          err.textContent = x.message;
        }
      },
    },
    el('h1', {}, 'Sign in'),
    el('label', {}, 'Username', user),
    el('label', {}, 'Password', pass),
    el('button', { class: 'btn primary', type: 'submit' }, 'Sign in'),
    err,
  );
  fill(view, form);
  user.focus();
}

async function searchPage(view, params) {
  const q = el('input', { placeholder: 'Serial, model, asset tag or UUID', value: params.get('q') || '', size: 32 });
  const site = el('select', {}, el('option', { value: '' }, 'All sites'), (me.sites || []).map((s) => el('option', { value: s.code, selected: params.get('site') === s.code }, `${s.code} · ${s.name}`)));
  const overall = el('select', {}, ['', 'pass', 'fail', 'incomplete'].map((v) => el('option', { value: v, selected: params.get('overall') === v }, v || 'Any result')));
  const profile = el('select', {}, [['', 'Intake and full'], ['intake', 'Intake'], ['full', 'Full audit']].map(([v, t]) => el('option', { value: v, selected: params.get('profile') === v }, t)));
  const from = el('input', { type: 'date', value: params.get('from') || '', title: 'Completed from (inclusive)' });
  const to = el('input', { type: 'date', value: params.get('to') || '', title: 'Completed before (exclusive)' });
  const qs = () => new URLSearchParams(Object.entries({ q: q.value.trim(), site: site.value, overall: overall.value, profile: profile.value, from: from.value, to: to.value }).filter(([, v]) => v)).toString();
  const go = (e) => {
    e?.preventDefault();
    location.hash = `#/?${qs()}`;
  };
  const csv = el('a', { class: 'btn', href: `/api/v1/audits.csv?${qs()}` }, 'Export CSV');
  // Compliance export: a PDF per record (drawn on demand) plus a CSV summary.
  const exportFilters = () => new URLSearchParams(Object.entries({ site: site.value, overall: overall.value, profile: profile.value, from: from.value, to: to.value }).filter(([, v]) => v));
  const zip = el(
    'button',
    {
      class: 'btn',
      type: 'button',
      title: 'One PDF per record plus a CSV summary, for the current site, result and dates',
      onclick: () => {
        const f = exportFilters();
        if (!f.get('site') && !f.get('from') && !f.get('to')) return toast('Choose a site or a date range to export.', 'error');
        location.href = `/api/v1/export.zip?${f}`;
      },
    },
    'Export PDFs (ZIP)',
  );
  const serialList = el('textarea', { rows: 4, cols: 60, placeholder: 'One serial number per line (or separated by commas)' });
  const bySerial = el(
    'details',
    { class: 'card' },
    el('summary', {}, 'Export by serial list (e.g. a client lot)'),
    el('p', { class: 'muted small' }, 'Paste serial numbers; you get one PDF per matching record plus a CSV summary.'),
    serialList,
    el('div', { class: 'row' }, el('button', { class: 'btn primary', type: 'button', onclick: () => {
      const list = serialList.value.split(/[\s,;]+/).filter(Boolean);
      if (!list.length) return toast('Paste at least one serial number.', 'error');
      location.href = `/api/v1/export.zip?${new URLSearchParams({ serials: list.join(',') })}`;
    } }, 'Export PDFs (ZIP)')),
  );
  const results = el('div', {}, el('p', { class: 'muted' }, 'Loading…'));
  fill(
    view,
    el('h1', {}, 'Audits'),
    el('form', { class: 'row filters', onsubmit: go }, q, site, overall, profile, from, el('span', { class: 'muted' }, 'to'), to, el('button', { class: 'btn primary', type: 'submit' }, 'Search'), csv, zip),
    bySerial,
    results,
  );
  try {
    const query = new URLSearchParams(qs());
    query.set('limit', '200');
    const { items } = await api(`/audits?${query}`);
    fill(
      results,
      items.length
        ? el(
            'table',
            { class: 'grid card' },
            el('thead', {}, el('tr', {}, ['Completed', 'Site', 'Serial', 'Unit', 'Profile', 'Result', 'MDM', 'Malware', 'Technician'].map((h) => el('th', {}, h)))),
            el(
              'tbody',
              {},
              items.map((a) =>
                el(
                  'tr',
                  { class: 'clickable', onclick: () => (location.hash = `#/audit/${a.id}`) },
                  el('td', {}, when(a.completedAt)),
                  el('td', {}, a.site),
                  el('td', {}, el('strong', {}, a.serial || a.assetTag || '—')),
                  el('td', {}, [a.manufacturer, a.model].filter(Boolean).join(' ') || '—'),
                  el('td', {}, a.profile),
                  el('td', {}, badge(a.overall)),
                  el('td', {}, badge(a.mdm)),
                  el('td', {}, badge(a.malware)),
                  el('td', {}, a.technician || ''),
                ),
              ),
            ),
          )
        : el('p', { class: 'muted' }, 'No audits match.'),
      items.length === 200 ? el('p', { class: 'muted small' }, 'Showing the newest 200. Narrow the search, or use the API to export everything.') : null,
    );
  } catch (x) {
    fill(results, el('p', { class: 'badge fail' }, x.message));
  }
}

async function auditPage(view, id) {
  fill(view, el('p', { class: 'muted' }, 'Loading…'));
  const a = await api(`/audits/${encodeURIComponent(id)}`);
  const r = a.record || {};
  const sys = r.hardware?.system || {};
  const tests = Object.entries(r.tests || {});
  const raw = el('pre', { class: 'json hidden' }, JSON.stringify(r, null, 2));
  fill(
    view,
    el('div', { class: 'row' }, el('a', { class: 'btn', href: '#/' }, '← Audits'), el('a', { class: 'btn primary', href: `/api/v1/audits/${a.id}/report.pdf`, target: '_blank', rel: 'noopener' }, 'Download PDF')),
    el('h1', {}, `${a.serial || a.assetTag || 'No serial'} `, badge(a.overall)),
    el('p', { class: 'muted' }, `${[a.manufacturer, a.model].filter(Boolean).join(' ')} · ${a.site} · ${a.station} · ${when(a.completedAt)}`),
    el(
      'div',
      { class: 'cards' },
      el('section', { class: 'card' }, el('h2', {}, 'Unit'), kv([['Serial', a.serial], ['UUID', a.uuid], ['Asset tag', a.assetTag], ['Manufacturer', sys.manufacturer], ['Model', sys.model], ['Version', sys.version], ['Unit type', sys.formFactor]])),
      el('section', { class: 'card' }, el('h2', {}, 'Audit'), kv([['Profile', a.profile], ['MDM', a.mdm ? badge(a.mdm) : null], ['Malware', a.malware ? badge(a.malware) : null], ['Technician', a.technician], ['App', a.appVersion], ['Received', when(a.receivedAt)], ['Record id', a.id]])),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', {}, 'Tests'),
      el('table', { class: 'grid' }, el('tbody', {}, tests.map(([tid, t]) => el('tr', {}, el('td', {}, tid), el('td', {}, badge(t.status)), el('td', { class: 'small' }, t.details?.summary || t.details?.autoNa || ''), el('td', { class: 'small muted' }, t.notes || ''))))),
    ),
    el('section', { class: 'card' }, el('div', { class: 'row' }, el('h2', {}, 'Full record'), el('button', { class: 'btn small', onclick: () => raw.classList.toggle('hidden') }, 'Show / hide')), raw, el('p', { class: 'muted small' }, `Tamper-evidence hash ${a.hash}`)),
  );
}

// ------------------------------------------------------------------ admin

function secretBox(title, key) {
  return el('div', { class: 'card' }, el('strong', {}, title), el('p', { class: 'small' }, 'Copy it now: it is never shown again.'), el('div', { class: 'secret' }, key));
}

async function adminPage(view) {
  const out = el('div', {});
  const [sites, stations, clients, users, log, wifiInfo, stickInfo] = await Promise.all(['/sites', '/stations', '/api-clients', '/users', '/admin-log', '/settings/wifi', '/sticks'].map((p) => api(p)));
  const siteOptions = () => sites.map((s) => el('option', { value: s.code }, `${s.code} · ${s.name}`));
  const refresh = () => adminPage(view);
  const act = (fn) => async (e) => {
    e.preventDefault();
    try {
      await fn(e.target);
    } catch (x) {
      toast(x.message, 'error');
    }
  };
  const field = (name, props = {}) => el('input', { name, ...props });

  fill(
    view,
    el('h1', {}, 'Administration'),
    out,
    sticksCard(stickInfo, refresh),
    el(
      'div',
      { class: 'cards' },
      el(
        'section',
        { class: 'card' },
        el('h2', {}, 'Sites'),
        el('table', { class: 'grid' }, el('tbody', {}, sites.map((s) => el('tr', {}, el('td', {}, el('strong', {}, s.code)), el('td', {}, s.name), el('td', {}, el('button', { class: 'btn small', onclick: async () => { const v = await api(`/sites/${s.code}/verify`); toast(v.ok ? `${s.code}: chain intact (${v.checked} audits)` : `${s.code}: CHAIN BROKEN at ${v.brokenAt} (${v.reason})`, v.ok ? '' : 'error'); } }, 'Verify')))))),
        el('form', { class: 'row', onsubmit: act(async (f) => { await api('/sites', { method: 'POST', body: { code: f.code.value, name: f.name.value } }); toast('Site added'); refresh(); }) }, field('code', { placeholder: 'Code (e.g. DAL)', size: 8, required: true }), field('name', { placeholder: 'Name', required: true }), el('button', { class: 'btn primary' }, 'Add site')),
      ),
      el(
        'section',
        { class: 'card' },
        el('h2', {}, 'Stations'),
        el('table', { class: 'grid' }, el('tbody', {}, stations.map((s) => el('tr', {}, el('td', {}, s.site), el('td', {}, s.name, el('div', { class: 'muted small' }, `${s.key_prefix}… · ${s.last_seen_at ? `seen ${when(s.last_seen_at)}` : 'never seen'}${s.last_app_version ? ` · v${s.last_app_version}` : ''}`)), el('td', {}, s.revoked_at ? el('span', { class: 'badge' }, 'revoked') : el('button', { class: 'btn small danger', onclick: async () => { if (confirm(`Revoke ${s.name}? It can no longer upload.`)) { await api(`/stations/${s.id}/revoke`, { method: 'POST' }); refresh(); } } }, 'Revoke')))))),
        el('form', { class: 'row', onsubmit: act(async (f) => { const r = await api('/stations', { method: 'POST', body: { site: f.site.value, name: f.name.value } }); fill(out, secretBox(`Station key for ${r.site} · ${r.name}`, r.key)); refresh().then(() => {}); setTimeout(() => window.scrollTo(0, 0)); }) }, el('select', { name: 'site' }, siteOptions()), field('name', { placeholder: 'Station name', required: true }), el('button', { class: 'btn primary' }, 'Enroll')),
      ),
      el(
        'section',
        { class: 'card' },
        el('h2', {}, 'Integrations (WMS, Tableau)'),
        el('table', { class: 'grid' }, el('tbody', {}, clients.map((c) => el('tr', {}, el('td', {}, c.name, el('div', { class: 'muted small' }, `${c.key_prefix}… · ${c.sites ? c.sites.join(', ') : 'all sites'} · ${c.last_used_at ? `used ${when(c.last_used_at)}` : 'never used'}`)), el('td', {}, c.revoked_at ? el('span', { class: 'badge' }, 'revoked') : el('button', { class: 'btn small danger', onclick: async () => { if (confirm(`Revoke ${c.name}?`)) { await api(`/api-clients/${c.id}/revoke`, { method: 'POST' }); refresh(); } } }, 'Revoke')))))),
        el('form', { class: 'row', onsubmit: act(async (f) => { const r = await api('/api-clients', { method: 'POST', body: { name: f.name.value, sites: f.site.value ? [f.site.value] : [] } }); fill(out, secretBox(`API key for ${r.name}`, r.key)); setTimeout(() => window.scrollTo(0, 0)); }) }, field('name', { placeholder: 'Name (e.g. WMS)', required: true }), el('select', { name: 'site' }, el('option', { value: '' }, 'All sites'), siteOptions()), el('button', { class: 'btn primary' }, 'Create key')),
      ),
      wifiCard(wifiInfo, act, refresh),
      el(
        'section',
        { class: 'card' },
        el('h2', {}, 'Users'),
        el('table', { class: 'grid' }, el('tbody', {}, users.map((u) => el('tr', {}, el('td', {}, u.username), el('td', {}, u.role), el('td', { class: 'small' }, u.all_sites ? 'all sites' : u.sites.join(', ')), el('td', {}, u.disabled_at ? el('span', { class: 'badge' }, 'disabled') : u.username === me.name ? '' : el('button', { class: 'btn small danger', onclick: async () => { if (confirm(`Disable ${u.username}?`)) { await api(`/users/${u.id}/disable`, { method: 'POST' }); refresh(); } } }, 'Disable')))))),
        el('form', { class: 'row', onsubmit: act(async (f) => { await api('/users', { method: 'POST', body: { username: f.username.value.trim().toLowerCase(), password: f.password.value, role: f.role.value, sites: f.site.value ? [f.site.value] : [] } }); toast('User added'); refresh(); }) }, field('username', { placeholder: 'username', required: true, size: 12 }), field('password', { type: 'password', placeholder: 'Password (12+)', required: true, autocomplete: 'new-password', size: 14 }), el('select', { name: 'role' }, ['viewer', 'lead', 'admin'].map((r) => el('option', { value: r }, r))), el('select', { name: 'site' }, el('option', { value: '' }, 'All sites'), siteOptions()), el('button', { class: 'btn primary' }, 'Add user')),
      ),
    ),
    el('section', { class: 'card' }, el('h2', {}, 'Admin log'), el('table', { class: 'grid' }, el('tbody', {}, log.map((l) => el('tr', {}, el('td', { class: 'small' }, when(l.at)), el('td', {}, l.actor), el('td', {}, l.action), el('td', { class: 'small muted' }, JSON.stringify(l.detail))))))),
  );
}

// ------------------------------------------------------------------ first-run setup wizard

let setupNeeded = null;

async function setupApi(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`/api/v1/setup${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { 'x-setup-token': token } : {}), ...(method !== 'GET' ? { 'x-benchwise': '1' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

function setupPage(view) {
  const s = {
    step: 0,
    token: null,
    env: null,
    site: { code: '', name: '', timeZone: 'America/Chicago' },
    network: { mode: 'one', companyIp: '', floorIp: '' },
    certificate: { mode: 'generated', certPem: '', keyPem: '' },
    wifi: { ssid: '', password: '', security: 'wpa2', hidden: false },
    admin: { username: 'admin', password: '', confirm: '' },
  };
  const STEPS = ['Setup code', 'Facility', 'Networks', 'Certificate', 'Sticks', 'Administrator', 'Review'];
  const err = el('div', {});
  const showErrors = (list) => fill(err, list.length ? el('div', { class: 'card errors' }, el('strong', {}, 'Please fix:'), el('ul', {}, list.map((e) => el('li', {}, e)))) : null);
  const bind = (obj, key, props = {}) => el('input', { value: obj[key], oninput: (e) => (obj[key] = e.target.value), ...props });
  const field = (label, control, help) => el('label', { class: 'field' }, el('span', {}, label), control, help ? el('small', { class: 'muted' }, help) : null);
  const ifaceLabel = (i) => `${i.name} — ${i.address}${i.cidr ? ` (${i.cidr})` : ''}`;

  const pages = [
    // 0 setup code
    () => {
      const code = el('input', { placeholder: 'XXXXX-XXXXX', autocomplete: 'off', spellcheck: 'false', size: 14, class: 'code' });
      setTimeout(() => code.focus());
      return {
        body: [el('p', {}, 'Welcome. This server is new: set it up in a few steps. Enter the setup code printed at the end of the install.'), field('Setup code', code)],
        next: async () => {
          s.token = (await setupApi('/verify', { method: 'POST', body: { code: code.value } })).token;
          s.env = await setupApi('/environment', { token: s.token });
          const ifs = s.env.interfaces;
          s.network.companyIp = ifs[0]?.address || '';
          s.network.floorIp = ifs[1]?.address || '';
        },
      };
    },
    // 1 facility
    () => ({
      body: [
        field('Facility code', bind(s.site, 'code', { placeholder: 'e.g. DAL', size: 10, maxlength: 16 }), 'Short and unique across your facilities: it appears in every record.'),
        field('Facility name', bind(s.site, 'name', { placeholder: 'e.g. Dallas warehouse', size: 40 })),
        field('Time zone', el('select', { onchange: (e) => (s.site.timeZone = e.target.value) }, s.env.timeZones.map((tz) => el('option', { value: tz, selected: tz === s.site.timeZone }, tz.replace(/_/g, ' '))))),
      ],
      check: () => [!/^[A-Za-z0-9][A-Za-z0-9-]{1,15}$/.test(s.site.code) && 'Facility code: 2-16 letters, digits or dashes.', !s.site.name.trim() && 'Facility name is required.'].filter(Boolean),
    }),
    // 2 networks
    () => {
      const ifs = s.env.interfaces;
      const choice = (mode, title, text) =>
        el('label', { class: `choice${s.network.mode === mode ? ' active' : ''}` }, el('input', { type: 'radio', name: 'netmode', checked: s.network.mode === mode, onchange: () => ((s.network.mode = mode), render()) }), el('div', {}, el('strong', {}, title), el('p', { class: 'muted small' }, text)));
      const pick = (key, label) => field(label, el('select', { onchange: (e) => (s.network[key] = e.target.value) }, ifs.map((i) => el('option', { value: i.address, selected: s.network[key] === i.address }, ifaceLabel(i)))));
      return {
        body: [
          choice('one', 'One network', 'Benches, sticks and staff all reach this server on the same network (e.g. installed directly on an existing warehouse network).'),
          choice('two', 'Two networks (recommended when available)', 'Like your current server: a company side for staff and the Hub, and a floor side for the units under test. Nothing is routed between them.'),
          s.network.mode === 'two'
            ? ifs.length < 2
              ? el('p', { class: 'badge fail' }, `This server has only ${ifs.length} network address. Add a second network card for two networks.`)
              : el('div', { class: 'cards' }, el('div', {}, pick('companyIp', 'Company side (staff)')), el('div', {}, pick('floorIp', 'Floor side (benches and sticks)')))
            : el('p', { class: 'muted small' }, `Addresses on this server: ${ifs.map((i) => i.address).join(', ') || 'none found'}`),
        ],
        check: () => (s.network.mode === 'two' ? [ifs.length < 2 && 'Two networks need two network cards.', s.network.companyIp === s.network.floorIp && 'Choose different cards for the company and floor sides.'].filter(Boolean) : []),
      };
    },
    // 3 certificate
    () => {
      const choice = (mode, title, text) =>
        el('label', { class: `choice${s.certificate.mode === mode ? ' active' : ''}` }, el('input', { type: 'radio', name: 'certmode', checked: s.certificate.mode === mode, onchange: () => ((s.certificate.mode = mode), render()) }), el('div', {}, el('strong', {}, title), el('p', { class: 'muted small' }, text)));
      const fileInto = (key) => el('input', { type: 'file', accept: '.pem,.crt,.cer,.key,.txt', onchange: async (e) => { s.certificate[key] = await e.target.files[0].text(); render(); } });
      return {
        body: [
          choice('generated', 'Use the certificate made by the installer', `Fine for most sites. Sticks trust it by its fingerprint: ${s.env.generatedCertificate.fingerprint || '(shown after setup)'}`),
          choice('upload', "Use our company's certificate", "If your IT issues internal certificates. Benches and PCs already trust it, so no fingerprint is needed."),
          s.certificate.mode === 'upload'
            ? el('div', {},
                field('Certificate (PEM)', el('div', {}, fileInto('certPem'), el('textarea', { rows: 4, cols: 70, value: s.certificate.certPem, placeholder: '-----BEGIN CERTIFICATE-----', oninput: (e) => (s.certificate.certPem = e.target.value) }))),
                field('Private key (PEM, no password)', el('div', {}, fileInto('keyPem'), el('textarea', { rows: 4, cols: 70, value: s.certificate.keyPem, placeholder: '-----BEGIN PRIVATE KEY-----', oninput: (e) => (s.certificate.keyPem = e.target.value) }))))
            : null,
        ],
        check: () => (s.certificate.mode === 'upload' ? [!s.certificate.certPem.includes('-----BEGIN') && 'Add the certificate.', !s.certificate.keyPem.includes('-----BEGIN') && 'Add the private key.'].filter(Boolean) : []),
      };
    },
    // 4 sticks (floor Wi-Fi)
    () => ({
      body: [
        el('p', {}, 'USB sticks made by this server join this Wi-Fi during Windows setup: units need internet for the MDM check. Leave the name empty if the floor is wired only. It can be changed any time under Administration.'),
        field('Floor Wi-Fi name (SSID)', bind(s.wifi, 'ssid', { size: 32, maxlength: 32, autocomplete: 'off' })),
        field('Security', el('select', { onchange: (e) => ((s.wifi.security = e.target.value), render()) }, [['wpa2', 'WPA2-Personal'], ['wpa3', 'WPA3-Personal'], ['open', 'Open (no password)']].map(([v, t]) => el('option', { value: v, selected: s.wifi.security === v }, t)))),
        s.wifi.security === 'open' ? null : field('Wi-Fi password', bind(s.wifi, 'password', { type: 'password', size: 32, maxlength: 63, autocomplete: 'new-password' }), 'Stored on this server and written onto the sticks it makes.'),
        el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: s.wifi.hidden, onchange: (e) => (s.wifi.hidden = e.target.checked) }), ' Hidden network (the name is not broadcast)'),
      ],
      check: () => (s.wifi.ssid && s.wifi.security !== 'open' && (s.wifi.password.length < 8 || s.wifi.password.length > 63) ? ['Wi-Fi password: 8-63 characters.'] : []),
    }),
    // 5 administrator
    () => ({
      body: [
        el('p', {}, 'The first administrator account for this server.'),
        field('Username', bind(s.admin, 'username', { autocomplete: 'username', size: 20 })),
        field('Password', bind(s.admin, 'password', { type: 'password', autocomplete: 'new-password', size: 28 }), 'At least 12 characters.'),
        field('Password again', bind(s.admin, 'confirm', { type: 'password', autocomplete: 'new-password', size: 28 })),
      ],
      check: () => [!/^[a-z0-9._-]{3,40}$/.test(s.admin.username) && 'Username: 3-40 lowercase letters, digits, dot, dash or underscore.', s.admin.password.length < 12 && 'Password: at least 12 characters.', s.admin.password !== s.admin.confirm && "The passwords don't match."].filter(Boolean),
    }),
    // 6 review
    () => ({
      body: [
        el('p', {}, 'Check and apply. If the networks change, the server restarts and moves to its new address; this page will tell you where.'),
        el('dl', { class: 'kv' },
          el('dt', {}, 'Facility'), el('dd', {}, `${s.site.code.toUpperCase()} · ${s.site.name} · ${s.site.timeZone}`),
          el('dt', {}, 'Networks'), el('dd', {}, s.network.mode === 'two' ? `Two: staff on ${s.network.companyIp}, floor on ${s.network.floorIp}` : 'One network'),
          el('dt', {}, 'Certificate'), el('dd', {}, s.certificate.mode === 'upload' ? 'Company certificate' : 'Made by the installer'),
          el('dt', {}, 'Sticks Wi-Fi'), el('dd', {}, s.wifi.ssid ? `${s.wifi.ssid} · ${s.wifi.security.toUpperCase()}${s.wifi.hidden ? ' · hidden' : ''}` : 'Not set (wired floor)'),
          el('dt', {}, 'Administrator'), el('dd', {}, s.admin.username)),
      ],
      nextLabel: 'Apply',
      next: async () => {
        const r = await setupApi('/apply', { method: 'POST', token: s.token, body: { site: s.site, network: s.network, certificate: s.certificate, wifi: s.wifi.ssid ? s.wifi : null, admin: s.admin } });
        if (!r.ok) throw Object.assign(new Error('Some settings need fixing.'), { list: r.errors });
        finish(r);
        return 'stop';
      },
    }),
  ];

  function finish(r) {
    const status = el('p', {}, 'Applying network and certificate settings…');
    fill(view, el('div', { class: 'card wizard' }, el('h1', {}, 'Setting up…'), status));
    const started = Date.now();
    const poll = async () => {
      let p = null;
      try {
        p = await setupApi('/progress');
      } catch {
        /* the server may be restarting */
      }
      if (p?.state === 'done') {
        setupNeeded = false;
        return fill(view, el('div', { class: 'card wizard' }, el('h1', {}, 'This server is ready'), el('p', {}, 'Sign in with the administrator account you just created.'), el('a', { class: 'btn primary', href: `${r.url}#/login` }, `Go to ${r.url}`)));
      }
      if (Date.now() - started > 60000) {
        // E.g. the networks changed and this page's address is now the floor side.
        return fill(status, el('p', {}, 'This is taking longer than expected, or the server has moved to its new address.'), el('a', { class: 'btn primary', href: `${r.url}#/login` }, `Try ${r.url}`));
      }
      if (p?.state === 'failed') return fill(status, el('span', { class: 'badge fail' }, `Network/certificate settings weren't applied: ${p.message}`), el('p', { class: 'small' }, 'Your facility and administrator are saved. Fix the issue, then set the networks by re-running the installer (sudo ./deploy/install.sh --one-network, or --company-ip … --floor-ip …).'));
      setTimeout(poll, 1500);
    };
    setTimeout(poll, 1500);
  }

  function render() {
    const page = pages[s.step]();
    const back = s.step > 0 ? el('button', { class: 'btn', onclick: () => ((s.step -= 1), showErrors([]), render()) }, 'Back') : null;
    const next = el('button', { class: 'btn primary', onclick: async () => {
      const problems = page.check ? page.check() : [];
      if (problems.length) return showErrors(problems);
      next.disabled = true;
      try {
        const r = page.next ? await page.next() : null;
        if (r === 'stop') return;
        s.step += 1;
        showErrors([]);
        render();
      } catch (x) {
        showErrors(x.list || [x.message]);
        next.disabled = false;
      }
    } }, page.nextLabel || 'Next');
    fill(
      view,
      el(
        'div',
        { class: 'card wizard' },
        el('div', { class: 'steps' }, STEPS.map((t, i) => el('span', { class: i === s.step ? 'active' : i < s.step ? 'done' : '' }, `${i + 1}. ${t}`))),
        el('h1', {}, STEPS[s.step]),
        page.body,
        err,
        el('div', { class: 'row' }, back, next),
      ),
    );
  }
  render();
}

/** USB sticks made at this server: the Benchwise build, the drives plugged in, progress. */
function sticksCard(info, refresh) {
  const progress = el('div', {});
  const address = el('input', { value: info.defaults.serverAddress || '', size: 18, title: 'The address benches and sticks use to reach this server (the floor side)' });
  const pre = el('input', { type: 'checkbox' });
  const upload = el('input', { type: 'file', accept: '.zip', class: 'hidden', onchange: async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    fill(progress, el('p', {}, `Uploading ${f.name}…`));
    try {
      const res = await fetch(`/api/v1/sticks/app?name=${encodeURIComponent(f.name)}`, { method: 'PUT', body: f, credentials: 'same-origin', headers: { 'content-type': 'application/zip', 'x-benchwise': '1' } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast(`Benchwise ${data.app.version} ready for sticks`);
      refresh();
    } catch (x) {
      fill(progress, el('p', { class: 'badge fail' }, x.message));
    }
  } });
  const fetchLatest = async () => {
    fill(progress, el('p', {}, 'Downloading the latest Benchwise release from GitHub…'));
    try {
      const r = await api('/sticks/app/fetch', { method: 'POST', body: { includePrerelease: pre.checked } });
      toast(`Benchwise ${r.app.version} ready for sticks${r.app.verified ? ' (checksum verified)' : ''}`);
      refresh();
    } catch (x) {
      fill(progress, el('p', { class: 'badge fail' }, x.message));
    }
  };
  const make = async (d) => {
    if (!confirm(`Erase EVERYTHING on ${d.model} (${d.size}${d.label ? `, "${d.label}"` : ''}) and make it a Benchwise stick?`)) return;
    let job;
    try {
      job = await api('/sticks', { method: 'POST', body: { device: d.name, serial: d.serial, serverAddress: address.value.trim() } });
    } catch (x) {
      return fill(progress, el('p', { class: 'badge fail' }, x.message));
    }
    const line = el('p', {}, `${job.station}: queued…`);
    fill(progress, el('div', { class: 'card' }, el('strong', {}, `Making ${job.station} on ${d.model}`), line));
    const poll = async () => {
      const st = await api(`/sticks/jobs/${job.jobId}`).catch(() => ({ state: 'working' }));
      if (st.state === 'done') {
        fill(line, el('span', { class: 'badge pass' }, 'Done'), ` ${job.station} is ready. You can remove the stick.`);
        return refresh();
      }
      if (st.state === 'failed') return fill(line, el('span', { class: 'badge fail' }, 'Failed'), ` ${st.message} (the stick's key was revoked).`);
      line.textContent = `${job.station}: ${st.step || st.state}…`;
      setTimeout(poll, 1500);
    };
    setTimeout(poll, 1500);
  };
  const a = info.app;
  return el(
    'section',
    { class: 'card' },
    el('h2', {}, 'USB sticks'),
    el('p', { class: 'muted small' }, 'Plug a USB drive into this server and make it a Benchwise stick: Benchwise, the floor Wi-Fi and this server\'s address, with its own station key.'),
    !info.wifi ? el('p', { class: 'badge incomplete' }, 'No floor Wi-Fi set: sticks will need a wired connection.') : null,
    a?.tooOld ? el('p', { class: 'badge incomplete' }, a.tooOld) : null,
    el('p', { class: 'muted small' }, `Sticks need Benchwise ${info.minVersion} or later (older builds can't send reports to this server).`),
    el('p', {}, el('strong', {}, 'Benchwise for sticks: '), a ? `${a.version} (${a.source === 'github' ? `GitHub${a.verified ? ', checksum verified' : ''}` : 'uploaded'}, ${new Date(a.at).toLocaleDateString()})` : el('span', { class: 'muted' }, 'none yet')),
    el('div', { class: 'row' }, el('button', { class: 'btn', onclick: fetchLatest }, 'Get latest release'), el('label', { class: 'small' }, pre, ' include pre-releases'), el('button', { class: 'btn', onclick: () => upload.click() }, 'Upload ZIP…'), upload),
    el('div', { class: 'row spaced' }, el('span', { class: 'small' }, 'Address sticks use:'), address),
    el('table', { class: 'grid' }, el('tbody', {},
      info.drives.length
        ? info.drives.map((d) => el('tr', {},
            el('td', {}, el('strong', {}, d.model), el('div', { class: 'muted small' }, [`/dev/${d.name}`, d.size, d.serial && `S/N ${d.serial}`, d.label && `"${d.label}"`].filter(Boolean).join(' · '))),
            el('td', {}, d.eligible ? el('button', { class: 'btn primary small', disabled: !a || Boolean(a.tooOld), onclick: () => make(d) }, 'Make stick') : el('span', { class: 'muted small' }, d.why))))
        : el('tr', {}, el('td', { class: 'muted' }, 'No USB drive plugged into this server.')))),
    el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: refresh }, 'Refresh drives')),
    progress,
  );
}

/** Floor Wi-Fi that USB sticks join (shown without its password). */
function wifiCard({ wifi, securityOptions }, act, refresh) {
  const w = wifi || { ssid: '', security: 'wpa2', hidden: false, passwordSet: false };
  return el(
    'section',
    { class: 'card' },
    el('h2', {}, 'Floor Wi-Fi (USB sticks)'),
    el('p', { class: 'muted small' }, 'Sticks join this network during Windows setup (the MDM check needs internet). Sticks pick up a change the next time they reach this server.'),
    wifi
      ? el('p', {}, el('strong', {}, wifi.ssid), ` · ${securityOptions.find((o) => o.value === wifi.security)?.label || wifi.security}${wifi.hidden ? ' · hidden' : ''}`, el('span', { class: 'muted small' }, wifi.updatedAt ? ` · changed ${new Date(wifi.updatedAt).toLocaleString()}` : ''))
      : el('p', { class: 'muted' }, 'Not set: sticks need a wired connection.'),
    el(
      'form',
      {
        class: 'row',
        onsubmit: act(async (f) => {
          await api('/settings/wifi', { method: 'PUT', body: { ssid: f.ssid.value, password: f.password.value, security: f.security.value, hidden: f.hidden.checked } });
          toast('Floor Wi-Fi saved');
          refresh();
        }),
      },
      el('input', { name: 'ssid', placeholder: 'Wi-Fi name (SSID)', value: w.ssid, maxlength: 32, required: true, size: 16 }),
      el('select', { name: 'security' }, securityOptions.map((o) => el('option', { value: o.value, selected: o.value === w.security }, o.label))),
      el('input', { name: 'password', type: 'password', placeholder: w.passwordSet ? 'Password (unchanged)' : 'Password', autocomplete: 'new-password', maxlength: 63, size: 16 }),
      el('label', { class: 'small' }, el('input', { name: 'hidden', type: 'checkbox', checked: w.hidden }), ' hidden'),
      el('button', { class: 'btn primary' }, 'Save'),
    ),
  );
}

// ------------------------------------------------------------------ shell

function renderChrome(route) {
  const nav = $('nav');
  fill(
    nav,
    me
      ? [
          el('a', { href: '#/', class: route === 'search' || route === 'audit' ? 'active' : '' }, 'Audits'),
          me.role === 'admin' ? el('a', { href: '#/admin', class: route === 'admin' ? 'active' : '' }, 'Administration') : null,
        ]
      : [],
  );
  fill(
    $('who'),
    me
      ? [
          el('span', {}, `${me.name} · ${me.role}`),
          el('button', {
            class: 'btn small',
            onclick: async () => {
              await api('/session', { method: 'DELETE' }).catch(() => {});
              me = null;
              location.hash = '#/login';
            },
          }, 'Sign out'),
        ]
      : [],
  );
}

async function route() {
  const view = $('view');
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  // A brand-new server: the setup wizard comes first (no accounts exist yet).
  if (setupNeeded === null) setupNeeded = await setupApi('/status').then((x) => x.needed).catch(() => false);
  if (setupNeeded) {
    renderChrome('setup');
    return setupPage(view);
  }
  if (!me && path !== '/login') {
    try {
      me = await api('/me');
    } catch {
      return;
    }
  }
  const params = new URLSearchParams(query);
  try {
    if (path === '/login') {
      renderChrome('login');
      return loginPage(view);
    }
    if (path.startsWith('/audit/')) {
      renderChrome('audit');
      return await auditPage(view, path.slice('/audit/'.length));
    }
    if (path === '/admin' && me.role === 'admin') {
      renderChrome('admin');
      return await adminPage(view);
    }
    renderChrome('search');
    return await searchPage(view, params);
  } catch (x) {
    fill(view, el('p', { class: 'badge fail' }, x.message));
  }
}

window.addEventListener('hashchange', route);
route();
