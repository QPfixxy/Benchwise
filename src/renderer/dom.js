// Tiny DOM builder. Text is always inserted as text nodes, never parsed as
// HTML, so hardware strings or user input can't inject markup.

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') node.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') node[k] = Boolean(v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const c of [children].flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

let toastTimer;
export function toast(message, kind = 'info') {
  const t = document.getElementById('toast');
  t.textContent = message;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 3500);
}

/** Key/value list; rows with empty values are skipped unless `always`. */
export function kvList(rows) {
  return el(
    'dl',
    { class: 'kv' },
    rows
      .filter(([, v, always]) => always || (v !== null && v !== undefined && v !== ''))
      .map(([k, v]) => [el('dt', {}, k), el('dd', {}, v === null || v === undefined || v === '' ? '—' : v)]),
  );
}

export function table(headers, rows, { empty = 'None detected' } = {}) {
  if (!rows.length) return el('p', { class: 'muted' }, empty);
  return el(
    'table',
    { class: 'grid' },
    el('thead', {}, el('tr', {}, headers.map((h) => el('th', {}, h)))),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c) => el('td', {}, c ?? '—'))))),
  );
}

export const STATUS_LABEL = { pass: 'Pass', fail: 'Fail', na: 'N/A', untested: 'Not tested', incomplete: 'Incomplete' };

export function statusBadge(status) {
  return el('span', { class: `badge s-${status}` }, STATUS_LABEL[status] || status);
}

/** Like node.replaceChildren(), but flattens arrays and skips null/false. */
export function fill(node, ...children) {
  node.replaceChildren();
  return append(node, children);
}
