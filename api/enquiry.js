'use strict';
const { send, readJson, ipHash, siteUrl, wrap } = require('../lib/http');
const { db, countEvents, addEvent } = require('../lib/db');

const SERVICES = ['Digital Printing', 'Offset Printing', 'Flex & Banners', 'Visiting Cards', 'Wedding Cards', 'Stickers & Labels', 'Brochures & Pamphlets', 'Rubber Stamps', 'Photo Frames & Gifts', 'Other'];
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);

function allowedOrigin(req) {
  const o = req.headers.origin; if (!o) return true; // non-browser or same-origin GET-less posts
  try { const h = new URL(o).hostname; const base = new URL(siteUrl()).hostname.replace(/^www\./, ''); return h === base || h === 'www.' + base || h === 'localhost' || h === '127.0.0.1'; } catch { return false; }
}

module.exports = wrap(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
  if (!allowedOrigin(req)) return send(res, 403, { error: 'Request blocked.' });
  const b = await readJson(req);
  if (clean(b.website || b.company_url || b.botcheck, 50)) return send(res, 200, { ok: true }); // honeypot: pretend success

  const name = clean(b.name, 80), phone = clean(b.phone, 20).replace(/[^\d+]/g, '');
  const email = clean(b.email, 120), service = clean(b.service, 60), size = clean(b.size, 60), details = clean(b.details, 1500);
  const qty = b.quantity === '' || b.quantity == null ? null : parseInt(b.quantity, 10);
  const neededBy = clean(b.needed_by || b.neededBy, 10);
  const errors = {};
  if (name.length < 2) errors.name = 'Please enter your name.';
  if (!/^(\+?91)?[6-9]\d{9}$/.test(phone.replace(/^\+/, '+'))) errors.phone = 'Please enter a valid 10-digit mobile number.';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = 'Please enter a valid email.';
  if (!service) errors.service = 'Please choose a service.';
  if (qty !== null && (!Number.isInteger(qty) || qty < 1 || qty > 10000000)) errors.quantity = 'Quantity looks wrong.';
  if (neededBy && !/^\d{4}-\d{2}-\d{2}$/.test(neededBy)) errors.needed_by = 'Please use a valid date.';
  if (b.consent_operational !== true && b.consent !== true) errors.consent = 'Consent is required so we can contact you about this enquiry.';
  if (Object.keys(errors).length) return send(res, 400, { error: 'Please check the form.', fields: errors });

  const c = await db();
  if (!c) return send(res, 503, { error: 'Enquiry storage is not configured.' });
  const key = 'ip:' + ipHash(req);
  if (await countEvents(c, key, 'enquiry', 60) >= 8) return send(res, 429, { error: 'Too many enquiries from your network. Please call us on +91 95852 32399.' });
  await addEvent(c, key, 'enquiry', true);

  const r = await c.query(
    `INSERT INTO enquiries (name,phone,email,service,size,quantity,needed_by,details,consent_operational,consent_promotional,consent_version,source,user_agent,ip_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,'website',$11,$12) RETURNING id`,
    [name, phone, email || null, service, size || null, qty, neededBy || null, details || null, b.consent_promotional === true, clean(b.consent_version, 20) || 'v1', clean(req.headers['user-agent'], 200), ipHash(req)]);
  return send(res, 201, { ok: true, id: Number(r[0].id) });
});
module.exports.SERVICES = SERVICES;
