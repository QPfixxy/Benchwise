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
  const [sites, stations, clients, users, log] = await Promise.all(['/sites', '/stations', '/api-clients', '/users', '/admin-log'].map((p) => api(p)));
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
