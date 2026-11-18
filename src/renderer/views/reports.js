import { el, fill, statusBadge, toast } from '../dom.js';

export default {
  mount(root, ctx) {
    let rows = [];
    const search = el('input', { type: 'search', placeholder: 'Search asset tag, serial, model, technician…', oninput: () => draw() });
    const body = el('div', {}, el('div', { class: 'loading' }, el('span', { class: 'spinner' }), 'Loading reports…'));
    const dirNote = el('p', { class: 'muted small' }, ctx.state.settings.effectiveReportsDir);

    const act = (fn) => async (e) => {
      e.stopPropagation();
      try {
        await fn();
      } catch (err) {
        toast(err.message, 'error');
      }
    };

    function draw() {
      const q = search.value.trim().toLowerCase();
      const list = q
        ? rows.filter((r) => [r.assetTag, r.serial, r.model, r.manufacturer, r.technician].some((v) => v && v.toLowerCase().includes(q)))
        : rows;
      fill(body, 
        list.length
          ? el(
              'table',
              { class: 'grid' },
              el('thead', {}, el('tr', {}, ['Asset tag', 'Date', 'System', 'Serial', 'Tech', 'Result', ''].map((h) => el('th', {}, h)))),
              el(
                'tbody',
                {},
                list.map((r) =>
                  el(
                    'tr',
                    {},
                    el('td', {}, el('strong', {}, r.assetTag || r.serial || '—')),
                    el('td', {}, new Date(r.completedAt).toLocaleString()),
                    el('td', {}, [r.manufacturer, r.model].filter(Boolean).join(' ')),
                    el('td', {}, r.serial ? el('code', {}, r.serial) : '—'),
                    el('td', {}, r.technician || '—'),
                    el('td', {}, statusBadge(r.overall)),
                    el(
                      'td',
                      { class: 'actions' },
                      r.hasPdf ? el('button', { class: 'btn sm', onclick: act(() => ctx.api.openReport(r.file, 'pdf')) }, 'PDF') : null,
                      el('button', { class: 'btn sm ghost', onclick: act(() => ctx.api.openReport(r.file, 'json')) }, 'JSON'),
                      el('button', { class: 'btn sm ghost', onclick: act(() => ctx.api.revealReport(r.file)) }, 'Show'),
                    ),
                  ),
                ),
              ),
            )
          : el('p', { class: 'muted' }, rows.length ? 'No reports match your search.' : 'No reports saved yet.'),
      );
    }

    async function load() {
      try {
        rows = await ctx.api.listReports();
      } catch (err) {
        toast(err.message, 'error');
        rows = [];
      }
      draw();
    }

    root.append(
      el(
        'div',
        { class: 'page-head' },
        el('div', {}, el('h1', {}, 'Reports'), dirNote),
        el(
          'div',
          { class: 'row' },
          el('button', { class: 'btn ghost', onclick: load }, '↻ Refresh'),
          el('button', { class: 'btn ghost', onclick: act(() => ctx.api.openReportsDir()) }, 'Open folder'),
        ),
      ),
      search,
      body,
    );
    load();
    search.focus();
  },
};
