'use strict';
const { send, readJson, query, wrap } = require('../../lib/http');
const A = require('../../lib/auth');
const { db, audit } = require('../../lib/db');

const STATUSES = ['New', 'Contacted', 'Quoted', 'Confirmed', 'Closed', 'Spam'];
const like = (s) => '%' + s.replace(/[\\%_]/g, '\\$&') + '%';

function filters(q) {
  const w = [], p = [];
  const add = (sql, v) => { p.push(v); w.push(sql.replace('?', '$' + p.length)); };
  if (q.status && STATUSES.includes(q.status)) add('status = ?', q.status);
  if (q.service) add('service = ?', String(q.service).slice(0, 60));
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.from || '')) add("created_at >= (?::date AT TIME ZONE 'Asia/Kolkata')", q.from);
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.to || '')) add("created_at < ((?::date + 1) AT TIME ZONE 'Asia/Kolkata')", q.to);
  if (q.q && String(q.q).trim()) { p.push(like(String(q.q).trim().slice(0, 80))); const n = '$' + p.length; w.push(`(name ILIKE ${n} OR phone ILIKE ${n} OR email ILIKE ${n} OR details ILIKE ${n} OR CAST(id AS TEXT) ILIKE ${n})`); }
  return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', params: p };
}

module.exports = wrap(async (req, res) => {
  const s = A.requireAdmin(req, res); if (!s) return;
  const c = await db(); if (!c) return send(res, 503, { error: 'Database is not configured.' });
  const q = query(req);

  if (req.method === 'GET') {
    const page = Math.max(1, parseInt(q.page, 10) || 1), limit = Math.min(100, Math.max(5, parseInt(q.limit, 10) || 25));
    const { where, params } = filters(q);
    const total = (await c.query(`SELECT COUNT(*)::int AS n FROM enquiries ${where}`, params))[0].n;
    const rows = await c.query(`SELECT id, created_at, name, phone, email, service, size, quantity, needed_by::text AS needed_by, details, consent_promotional, status, note, handled_by, updated_at FROM enquiries ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params);
    const st = await c.query(`SELECT status, COUNT(*)::int AS n FROM enquiries GROUP BY status`);
    const byStatus = Object.fromEntries(STATUSES.map((x) => [x, 0])); st.forEach((r) => { byStatus[r.status] = r.n; });
    const t = (await c.query(`SELECT COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')::int AS today, COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS week, COUNT(*)::int AS total FROM enquiries`))[0];
    const services = (await c.query('SELECT DISTINCT service FROM enquiries ORDER BY service')).map((r) => r.service);
    return send(res, 200, { rows, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)), stats: { ...t, byStatus }, services, statuses: STATUSES });
  }

  const id = parseInt(q.id, 10);
  if (!Number.isInteger(id) || id < 1) return send(res, 400, { error: 'Invalid id.' });

  if (req.method === 'PATCH') {
    const b = await readJson(req, 8192); const sets = [], p = [];
    if (b.status !== undefined) { if (!STATUSES.includes(b.status)) return send(res, 400, { error: 'Invalid status.' }); p.push(b.status); sets.push('status=$' + p.length); }
    if (b.note !== undefined) { p.push(String(b.note).slice(0, 2000)); sets.push('note=$' + p.length); }
    if (!sets.length) return send(res, 400, { error: 'Nothing to update.' });
    p.push(s.name); sets.push('handled_by=$' + p.length); sets.push('updated_at=now()'); p.push(id);
    const r = await c.query(`UPDATE enquiries SET ${sets.join(', ')} WHERE id=$${p.length} RETURNING id, status, note, handled_by, updated_at`, p);
    if (!r.length) return send(res, 404, { error: 'Enquiry not found.' });
    await audit(c, s.name, 'update', id, JSON.stringify({ status: b.status, note: b.note !== undefined })).catch(() => {});
    return send(res, 200, { ok: true, row: r[0] });
  }
  if (req.method === 'DELETE') {
    const r = await c.query('DELETE FROM enquiries WHERE id=$1 RETURNING id', [id]);
    if (!r.length) return send(res, 404, { error: 'Enquiry not found.' });
    await audit(c, s.name, 'delete', id).catch(() => {});
    return send(res, 200, { ok: true });
  }
  return send(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, PATCH, DELETE' });
});
