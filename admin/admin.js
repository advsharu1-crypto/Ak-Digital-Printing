'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const H = { 'x-ak-admin': '1' };
  const state = { page: 1, status: '', rows: [], timer: null, current: null, loadSeq: 0 };

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v); }
    kids.flat().forEach((c) => { if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return n;
  }
  async function api(path, opt = {}) {
    const r = await fetch(path, { credentials: 'same-origin', ...opt, headers: { ...H, ...(opt.body ? { 'Content-Type': 'application/json' } : {}), ...(opt.headers || {}) } });
    let data = null; try { data = await r.json(); } catch (e) { /* non-JSON */ }
    if (r.status === 401 && path !== '/api/admin/login') { showLogin(); throw new Error('Session expired. Please sign in again.'); }
    if (!r.ok) throw new Error((data && data.error) || 'Request failed (' + r.status + ')');
    return data;
  }
  const fmt = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2800); }

  const ERR = { google_denied: 'Google sign-in was cancelled.', google_state: 'Sign-in expired. Please try again.', google_exchange: 'Google sign-in failed. Please try again.', google_token: 'Google sign-in could not be verified.', google_not_allowed: 'This Google account is not authorised for the dashboard.', google_not_configured: 'Google sign-in is not configured.' };

  function showLogin(methods) {
    clearInterval(state.timer); closeDrawer();
    $('app').hidden = true; $('login').hidden = false;
    document.title = 'Staff Login · AK Digital Printing';
    const code = new URLSearchParams(location.search).get('error');
    if (code) { const e = $('loginError'); e.textContent = ERR[code] || 'Sign-in failed.'; e.hidden = false; history.replaceState(null, '', '/admin'); }
    if (methods) {
      $('googleBtn').hidden = !methods.google; $('pwForm').hidden = !methods.password;
      $('orSep').hidden = !(methods.google && methods.password); $('noMethods').hidden = methods.google || methods.password;
    }
  }

  async function boot() {
    let me;
    try { me = await (await fetch('/api/admin/me', { credentials: 'same-origin' })).json(); }
    catch (e) { showLogin({}); const x = $('loginError'); x.textContent = 'Cannot reach the server.'; x.hidden = false; return; }
    if (!me.authenticated) return showLogin(me.methods);
    $('login').hidden = true; $('app').hidden = false; document.title = 'Enquiries · AK Digital Printing';
    $('whoName').textContent = me.user.name;
    await load();
    state.timer = setInterval(() => { if (!document.hidden && !$('drawer').classList.contains('open')) load(true); }, 60000);
  }

  $('showPw').addEventListener('click', (e) => { const p = $('p'); const show = p.type === 'password'; p.type = show ? 'text' : 'password'; e.target.textContent = show ? 'Hide' : 'Show'; e.target.setAttribute('aria-pressed', String(show)); });
  $('pwForm').addEventListener('submit', async (e) => {
    e.preventDefault(); const b = $('pwBtn'), err = $('loginError'); err.hidden = true; b.disabled = true; b.textContent = 'Signing in…';
    try { await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ username: $('u').value.trim(), password: $('p').value }) }); $('p').value = ''; await boot(); }
    catch (x) { err.textContent = x.message; err.hidden = false; $('p').value = ''; $('p').focus(); }
    finally { b.disabled = false; b.textContent = 'Sign in'; }
  });
  $('logoutBtn').addEventListener('click', async () => { try { await api('/api/admin/logout', { method: 'POST' }); } catch (e) { /* ignore */ } location.replace('/admin'); });

  function params() {
    const p = new URLSearchParams({ page: state.page, limit: 25 });
    const v = { q: $('fq').value.trim(), status: state.status, service: $('fservice').value, from: $('ffrom').value, to: $('fto').value };
    for (const [k, x] of Object.entries(v)) if (x) p.set(k, x);
    return p;
  }
  async function load(quiet) {
    const seq = ++state.loadSeq; const err = $('listError'); if (!quiet) err.hidden = true;
    try {
      const d = await api('/api/admin/enquiries?' + params());
      if (seq !== state.loadSeq) return;
      state.rows = d.rows; renderStats(d); renderFilters(d); renderRows(d);
    } catch (x) { if (!quiet) { err.textContent = x.message; err.hidden = false; } }
  }
  function renderStats(d) {
    const s = d.stats; const box = $('stats'); box.textContent = '';
    const tile = (label, n, status) => el('button', { type: 'button', class: 'stat' + (state.status === status ? ' on' : ''), 'aria-pressed': String(state.status === status), onclick: () => { state.status = status; state.page = 1; load(); } }, el('b', { text: n }), el('span', { text: label }));
    box.append(tile('All enquiries', s.total, ''), tile('New', s.byStatus.New, 'New'), tile('Contacted', s.byStatus.Contacted, 'Contacted'), tile('Quoted', s.byStatus.Quoted, 'Quoted'), tile('Confirmed', s.byStatus.Confirmed, 'Confirmed'), tile('Closed', s.byStatus.Closed, 'Closed'));
    box.append(el('div', { class: 'stat', 'aria-label': 'Today' }, el('b', { text: s.today }), el('span', { text: 'Today' })), el('div', { class: 'stat', 'aria-label': 'Last 7 days' }, el('b', { text: s.week }), el('span', { text: 'Last 7 days' })));
  }
  function renderFilters(d) {
    const fs = $('fstatus'); if (!fs.options.length) { fs.append(el('option', { value: '', text: 'All statuses' })); d.statuses.forEach((s) => fs.append(el('option', { value: s, text: s }))); }
    fs.value = state.status;
    const sv = $('fservice'), cur = sv.value; sv.textContent = ''; sv.append(el('option', { value: '', text: 'All services' })); d.services.forEach((s) => sv.append(el('option', { value: s, text: s }))); sv.value = cur;
  }
  function renderRows(d) {
    const body = $('rows'); body.textContent = '';
    d.rows.forEach((r) => {
      const tr = el('tr', { tabindex: '0', 'aria-label': 'Open enquiry ' + r.id, onclick: () => openDrawer(r), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(r); } } },
        el('td', { 'data-l': 'ID', text: '#' + r.id }), el('td', { 'data-l': 'Received', text: fmt(r.created_at) }),
        el('td', {}, el('b', { text: r.name }), el('small', { text: r.phone + (r.email ? ' · ' + r.email : '') })),
        el('td', { 'data-l': 'Service' }, r.service, r.size ? el('small', { text: r.size }) : null),
        el('td', { 'data-l': 'Qty', text: r.quantity == null ? '—' : r.quantity }),
        el('td', {}, el('span', { class: 'badge s-' + r.status, text: r.status })));
      body.append(tr);
    });
    $('empty').hidden = d.rows.length > 0; $('tbl').hidden = d.rows.length === 0;
    $('pageInfo').textContent = 'Page ' + d.page + ' of ' + d.pages + ' · ' + d.total + ' result' + (d.total === 1 ? '' : 's');
    $('prev').disabled = d.page <= 1; $('next').disabled = d.page >= d.pages; state.pages = d.pages;
  }
  $('prev').addEventListener('click', () => { if (state.page > 1) { state.page--; load(); } });
  $('next').addEventListener('click', () => { if (state.page < state.pages) { state.page++; load(); } });
  let dbt; const refilter = () => { clearTimeout(dbt); dbt = setTimeout(() => { state.page = 1; load(); }, 250); };
  $('fq').addEventListener('input', refilter); $('fservice').addEventListener('change', refilter); $('ffrom').addEventListener('change', refilter); $('fto').addEventListener('change', refilter);
  $('fstatus').addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; load(); });
  $('fclear').addEventListener('click', () => { $('fq').value = ''; $('fservice').value = ''; $('ffrom').value = ''; $('fto').value = ''; state.status = ''; state.page = 1; load(); });
  $('exportBtn').addEventListener('click', () => { location.href = '/api/admin/export' + (state.status ? '?status=' + encodeURIComponent(state.status) : ''); });

  // ---- drawer ----
  let lastFocus = null;
  function openDrawer(r) {
    state.current = r; lastFocus = document.activeElement; const b = $('dBody'); b.textContent = '';
    $('dTitle').textContent = 'Enquiry #' + r.id;
    const wa = '91' + r.phone.replace(/\D/g, '').slice(-10);
    const dl = el('dl', {});
    const add = (k, v) => { if (v != null && v !== '') dl.append(el('dt', { text: k }), el('dd', { text: v })); };
    add('Received', fmt(r.created_at)); add('Name', r.name); add('Phone', r.phone); add('Email', r.email); add('Service', r.service); add('Size', r.size); add('Quantity', r.quantity); add('Needed by', r.needed_by); add('Details', r.details); add('Marketing OK', r.consent_promotional ? 'Yes' : 'No'); if (r.handled_by) add('Last updated by', r.handled_by + ' · ' + fmt(r.updated_at));
    const msg = encodeURIComponent('Hello ' + r.name + ', this is AK Digital Printing regarding your ' + r.service + ' enquiry #' + r.id + '.');
    const status = el('select', { id: 'dStatus', 'aria-label': 'Status' }); ['New', 'Contacted', 'Quoted', 'Confirmed', 'Closed', 'Spam'].forEach((s) => status.append(el('option', { value: s, text: s }))); status.value = r.status;
    const note = el('textarea', { id: 'dNote', maxlength: '2000', 'aria-label': 'Internal note', placeholder: 'Internal note (not visible to the customer)' }); note.value = r.note || '';
    const save = el('button', { class: 'btn primary', type: 'button', onclick: () => saveRow(r, status.value, note.value, save) }, 'Save changes'); save.classList.add('small');
    const del = el('button', { class: 'btn small danger', type: 'button', onclick: () => removeRow(r, del) }, 'Delete');
    b.append(dl, el('div', { class: 'actions' }, el('a', { class: 'btn small', href: 'tel:' + r.phone }, 'Call'), el('a', { class: 'btn small', href: 'https://wa.me/' + wa + '?text=' + msg, target: '_blank', rel: 'noopener noreferrer' }, 'WhatsApp'), r.email ? el('a', { class: 'btn small', href: 'mailto:' + r.email }, 'Email') : null),
      el('label', { for: 'dStatus', text: 'Status' }), status, el('label', { for: 'dNote', text: 'Note' }), note, el('div', { class: 'row' }, save, del));
    $('drawer').classList.add('open'); $('drawer').setAttribute('aria-hidden', 'false'); $('scrim').hidden = false; $('dClose').focus();
  }
  function closeDrawer() { $('drawer').classList.remove('open'); $('drawer').setAttribute('aria-hidden', 'true'); $('scrim').hidden = true; if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* gone */ } } lastFocus = null; }
  $('dClose').addEventListener('click', closeDrawer); $('scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('drawer').classList.contains('open')) closeDrawer(); });
  async function saveRow(r, status, note, btn) {
    btn.disabled = true;
    try { await api('/api/admin/enquiries?id=' + r.id, { method: 'PATCH', body: JSON.stringify({ status, note }) }); toast('Saved'); closeDrawer(); await load(true); }
    catch (x) { toast(x.message); } finally { btn.disabled = false; }
  }
  async function removeRow(r, btn) {
    if (!confirm('Delete enquiry #' + r.id + ' from ' + r.name + '? This cannot be undone.')) return;
    btn.disabled = true;
    try { await api('/api/admin/enquiries?id=' + r.id, { method: 'DELETE' }); toast('Deleted'); closeDrawer(); await load(true); }
    catch (x) { toast(x.message); } finally { btn.disabled = false; }
  }
  boot();
})();
