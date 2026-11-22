'use strict';
const { send, query, wrap } = require('../../lib/http');
const A = require('../../lib/auth');
const { db, audit } = require('../../lib/db');

const esc = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };

module.exports = wrap(async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
  const s = A.requireAdmin(req, res); if (!s) return;
  const c = await db(); if (!c) return send(res, 503, { error: 'Database is not configured.' });
  const q = query(req); const p = []; const w = [];
  if (q.status && q.status !== 'all') { p.push(q.status); w.push('status=$' + p.length); }
  const rows = await c.query(`SELECT id, created_at, name, phone, email, service, size, quantity, needed_by::text AS needed_by, details, consent_promotional, status, note FROM enquiries ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 20000`, p);
  const head = ['ID', 'Received (IST)', 'Name', 'Phone', 'Email', 'Service', 'Size', 'Quantity', 'Needed by', 'Details', 'Marketing consent', 'Status', 'Note'];
  const ist = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  const lines = [head.map(esc).join(',')].concat(rows.map((r) => [r.id, ist(r.created_at), r.name, r.phone, r.email, r.service, r.size, r.quantity, r.needed_by, r.details, r.consent_promotional ? 'Yes' : 'No', r.status, r.note].map(esc).join(',')));
  await audit(c, s.name, 'export', null, String(rows.length) + ' rows').catch(() => {});
  return send(res, 200, '﻿' + lines.join('\r\n') + '\r\n', { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="ak-enquiries-${new Date().toISOString().slice(0, 10)}.csv"` });
});
