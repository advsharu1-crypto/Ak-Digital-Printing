'use strict';
const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const D = require('./db');
const compression = require('compression');
const PROD = process.env.NODE_ENV === 'production';
const P = require('./providers');

const TZ = 'Asia/Kolkata';
const nowISO = () => new Date().toISOString();
const istParts = (d = new Date()) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((p) => [p.type, p.value]));
const todayIST = (d) => { const p = istParts(d); return `${p.year}-${p.month}-${p.day}`; };
const hourIST = (d) => Number(istParts(d).hour);
const yearIST = (d) => Number(istParts(d).year);

class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const bad = (msg, extra) => new HttpError(422, msg, extra);

function createApp({ dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'ak.db'), uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'data', 'uploads'), publicDir = process.env.PUBLIC_DIR || [path.join(__dirname, '..', '..', 'dist'), path.join(__dirname, '..', '..', 'public')].find((d) => fs.existsSync(d)) || path.join(__dirname, '..', '..', 'dist') } = {}) {
  const db = D.open(dbFile);
  fs.mkdirSync(uploadsDir, { recursive: true });
  const q = (sql) => db.prepare(sql);
  const getSetting = (k) => q('SELECT value FROM settings WHERE key=?').get(k)?.value ?? '';
  const setSetting = (k, v) => q('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v ?? ''));

  // ---------- admin bootstrap ----------
  const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
  if (!q('SELECT COUNT(*) c FROM admins').get().c) {
    const u = process.env.ADMIN_USERNAME, pw = process.env.ADMIN_PASSWORD;
    if (u && pw) {
      if (pw.length < (PROD ? 12 : 10)) throw new Error(`ADMIN_PASSWORD must be at least ${PROD ? 12 : 10} characters`);
      const salt = crypto.randomBytes(16).toString('hex');
      q('INSERT INTO admins(username,pass_hash,salt,created_at) VALUES(?,?,?,?)').run(u, hashPw(pw, salt), salt, nowISO());
    } else console.warn('[ak] No admin account exists. Set ADMIN_USERNAME and ADMIN_PASSWORD and restart to create one.');
  }

  // OTP HMAC key: from env, or a random per-process key (pending OTPs simply expire on restart). Never a hardcoded default.
  const otpPepper = process.env.OTP_PEPPER || crypto.randomBytes(32).toString('hex');
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
  app.use(compression());

  // Request log: one JSON line per request; no query strings, bodies, phone numbers or tokens.
  app.use((req, res, next) => {
    const t0 = process.hrtime.bigint();
    res.on('finish', () => { if (process.env.LOG_REQUESTS === '0') return; const ms = Number(process.hrtime.bigint() - t0) / 1e6; console.log(JSON.stringify({ t: new Date().toISOString(), m: req.method, p: req.path.slice(0, 120), s: res.statusCode, ms: Math.round(ms) })); });
    next();
  });

  // Security headers for every response. HTML responses add a hash-based CSP below.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Body limits: large JSON only where images are uploaded (data URLs), small everywhere else.
  const bigJson = express.json({ limit: '8mb' }); const smallJson = express.json({ limit: '64kb' });
  app.use((req, res, next) => (/^\/api\/admin\/(promotions|gallery)(\/|$)/.test(req.path) ? bigJson : smallJson)(req, res, next));

  // Simple fixed-window rate limiter (per IP + bucket). Behind a proxy set TRUST_PROXY so req.ip is the client.
  const buckets = new Map();
  const limit = (name, max, windowMs) => (req, res, next) => {
    const k = name + '|' + req.ip; const now = Date.now(); const b = buckets.get(k);
    if (!b || now - b.t > windowMs) { buckets.set(k, { n: 1, t: now }); return next(); }
    if (++b.n > max) { res.setHeader('Retry-After', Math.ceil((b.t + windowMs - now) / 1000)); return next(new HttpError(429, 'Too many requests. Please wait a few minutes and try again.')); }
    next();
  };
  setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.t > 3600e3) buckets.delete(k); }, 600e3).unref();
  app.use('/api/enquiries', limit('enquiry', Number(process.env.RL_ENQUIRIES || 10), 10 * 60e3));
  app.use('/api/consent/withdraw', limit('withdraw', 10, 10 * 60e3));
  app.use('/api/admin', limit('admin', 600, 10 * 60e3));

  // CORS: none by default in production (the site and API share one origin). Set CORS_ORIGINS
  // (comma-separated, or "null" to allow the standalone HTML file) to permit other origins.
  const allowed = (process.env.CORS_ORIGINS || (PROD ? '' : '*')).split(',').map((s) => s.trim()).filter(Boolean);
  app.use((req, res, next) => {
    const o = req.headers.origin;
    if (o && (allowed.includes('*') || allowed.includes(o))) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ---------- auth ----------
  const failed = new Map();
  app.post('/api/admin/login', wrap((req, res) => {
    const ip = req.ip; const f = failed.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - f.t > 15 * 60e3) { f.n = 0; f.t = Date.now(); }
    if (f.n >= 5) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
    const { username, password } = req.body || {};
    const a = q('SELECT * FROM admins WHERE username=?').get(String(username || ''));
    const ok = a && crypto.timingSafeEqual(Buffer.from(hashPw(String(password || ''), a.salt), 'hex'), Buffer.from(a.pass_hash, 'hex'));
    if (!ok) { f.n++; failed.set(ip, f); throw new HttpError(401, 'Invalid username or password.'); }
    failed.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    q('INSERT INTO sessions(token_hash,admin_id,expires_at) VALUES(?,?,?)').run(sha(token), a.id, new Date(Date.now() + 12 * 3600e3).toISOString());
    res.json({ token, username: a.username, expires_in: 43200 });
  }));
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const auth = (req, res, next) => {
    const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const s = t && q('SELECT s.*, a.username FROM sessions s JOIN admins a ON a.id=s.admin_id WHERE token_hash=?').get(sha(t));
    if (!s || s.expires_at < nowISO()) return next(new HttpError(401, 'Please sign in again.'));
    req.admin = s.username; next();
  };
  app.post('/api/admin/password', auth, wrap((req, res) => {
    const { current, next: nw } = req.body || {};
    const a = q('SELECT * FROM admins WHERE username=?').get(req.admin);
    if (!a || !crypto.timingSafeEqual(Buffer.from(hashPw(String(current || ''), a.salt), 'hex'), Buffer.from(a.pass_hash, 'hex'))) throw new HttpError(401, 'Current password is incorrect.');
    if (String(nw || '').length < 12) throw bad('New password must be at least 12 characters.');
    const salt = crypto.randomBytes(16).toString('hex');
    q('UPDATE admins SET pass_hash=?, salt=? WHERE id=?').run(hashPw(String(nw), salt), salt, a.id);
    q('DELETE FROM sessions WHERE admin_id=?').run(a.id);
    res.json({ ok: true, message: 'Password changed. Please sign in again.' });
  }));
  app.post('/api/admin/logout', auth, (req, res) => { q('DELETE FROM sessions WHERE token_hash=?').run(sha((req.headers.authorization || '').slice(7))); res.json({ ok: true }); });

  // ---------- helpers ----------
  const providerStatus = () => ({
    sms: { configured: P.sms.isConfigured(), provider: 'MSG91 (DLT)', missing: P.sms.missing() },
    whatsapp: { configured: P.whatsapp.isConfigured(), provider: 'WhatsApp Cloud API', missing: P.whatsapp.missing() },
    otp: (() => { const miss = [!P.sms.isConfigured() && 'MSG91_AUTHKEY', ...['ADMIN_OTP_MOBILE', 'OTP_TEMPLATE_ID', 'OTP_DLT_TEMPLATE_ID', 'OTP_SENDER_ID'].filter((k) => !process.env[k])].filter(Boolean); return { configured: !miss.length, missing: miss }; })(),
    facebook: { configured: P.meta.facebookConfigured() }, instagram: { configured: P.meta.instagramConfigured() },
    sms_webhook: { configured: !!process.env.WEBHOOK_SECRET }
  });
  const customerById = (id) => q('SELECT * FROM customers WHERE id=?').get(id);

  /** Sends one message and records it. Never marks success unless the provider accepted it. */
  async function sendMessage({ customer, template, vars, purpose, orderId = null, campaignId = null, reviewRequestId = null, reminderLogId = null, requirePromo = false }) {
    const ch = template.channel; const provider = P.channel(ch);
    const to = P.normaliseIndianMobile(customer.phone);
    const body = P.render(template.body, vars);
    const ins = q('INSERT INTO communications(customer_id,order_id,channel,purpose,to_number,body,status,provider,campaign_id,review_request_id,reminder_log_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const t = nowISO();
    const fail = (status, err) => { const r = ins.run(customer.id, orderId, ch, purpose, to || customer.phone, body, status, provider.name, campaignId, reviewRequestId, reminderLogId, t, t); q('UPDATE communications SET error=? WHERE id=?').run(err, r.lastInsertRowid); return { id: Number(r.lastInsertRowid), status, error: err }; };
    if (!to) return fail('failed', 'Invalid Indian mobile number');
    if (requirePromo) { const fresh = customerById(customer.id); if (!fresh.promo_consent) return fail('not_sent', 'Promotional consent not active'); }
    if (!provider.isConfigured()) return fail('not_sent', `${ch.toUpperCase()} provider not configured`);
    const r = ins.run(customer.id, orderId, ch, purpose, to, body, 'pending', provider.name, campaignId, reviewRequestId, reminderLogId, t, t);
    const id = Number(r.lastInsertRowid);
    try {
      const out = await provider.send({ template, to, vars });
      q('UPDATE communications SET status=?, provider_message_id=?, updated_at=? WHERE id=?').run('sent', out.providerMessageId, nowISO(), id);
      return { id, status: 'sent' };
    } catch (e) {
      q('UPDATE communications SET status=?, error=?, updated_at=? WHERE id=?').run('failed', e.message, nowISO(), id);
      return { id, status: 'failed', error: e.message };
    }
  }
  const inPromoWindow = () => { const h = hourIST(); return h >= 9 && h < 21; };

  // ---------- public ----------
  app.get('/api/health', (req, res) => res.json({ ok: true, time: nowISO(), timezone: TZ }));
  app.get('/api/public/site', (req, res) => {
    const today = todayIST();
    const promos = q('SELECT id,title,kind,description,offer_text,banner_file,start_date,end_date FROM promotions WHERE enabled=1 AND start_date<=? AND end_date>=? ORDER BY start_date').all(today, today)
      .map((p) => ({ ...p, banner_url: p.banner_file ? '/uploads/' + p.banner_file : null }));
    res.json({
      google: { rating: getSetting('google_rating') || null, review_count: getSetting('google_review_count') || null, verified_at: getSetting('google_rating_verified_at') || null, review_url: getSetting('google_review_url') || null, maps_url: getSetting('google_maps_url') || null },
      socials: { facebook: getSetting('social_facebook'), instagram: getSetting('social_instagram'), whatsapp: getSetting('social_whatsapp') },
      consent: { version: D.CONSENT_VERSION, operational_text: D.OPERATIONAL_TEXT, promotional_text: D.PROMOTIONAL_TEXT },
      promotions: promos,
      gallery: q('SELECT id,title,categories,image_file FROM gallery_items WHERE enabled=1 ORDER BY sort DESC, id DESC LIMIT 60').all().map((g) => ({ id: g.id, title: g.title, categories: g.categories, image_url: '/uploads/' + g.image_file }))
    });
  });

  // Enquiry → order. All consent validation is here, on the server.
  app.post('/api/enquiries', wrap((req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim(); const phoneDigits = P.normaliseIndianMobile(b.phone);
    const service = String(b.service || '').trim();
    if (b.consent_operational !== true) throw bad('Operational consent is required before an order can be created.', { field: 'consent_operational' });
    if (b.consent_version !== D.CONSENT_VERSION) throw bad('Consent text has changed. Please reload the page and review the consent statements again.', { field: 'consent_version', current: D.CONSENT_VERSION });
    if (typeof b.consent_promotional !== 'boolean') throw bad('Promotional consent must be an explicit true/false choice.', { field: 'consent_promotional' });
    if (name.length < 2 || name.length > 80) throw bad('Please enter your name.', { field: 'name' });
    if (!phoneDigits) throw bad('Please enter a valid 10-digit Indian mobile number.', { field: 'phone' });
    if (!service || service.length > 80) throw bad('Please choose a service.', { field: 'service' });
    const qty = b.quantity === '' || b.quantity == null ? null : Number(b.quantity);
    if (qty !== null && (!Number.isInteger(qty) || qty < 1 || qty > 1e6)) throw bad('Quantity must be a whole number.', { field: 'quantity' });
    const email = b.email == null || b.email === '' ? null : String(b.email).trim().toLowerCase();
    if (email && (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))) throw bad('Please enter a valid email address.', { field: 'email' });
    const neededBy = b.needed_by ? String(b.needed_by) : null;
    if (neededBy && !/^\d{4}-\d{2}-\d{2}$/.test(neededBy)) throw bad('Invalid date.', { field: 'needed_by' });
    const phone = '+' + phoneDigits; const t = nowISO();
    const meta = { ip: req.ip, ua: String(req.headers['user-agent'] || '').slice(0, 300) };
    const out = D.tx(db, () => {
      let c = q('SELECT * FROM customers WHERE phone=?').get(phone);
      if (!c) { const r = q('INSERT INTO customers(name,phone,email,created_at,updated_at) VALUES(?,?,?,?,?)').run(name, phone, email, t, t); c = customerById(r.lastInsertRowid); }
      else q('UPDATE customers SET name=?, email=COALESCE(?,email), updated_at=? WHERE id=?').run(name, email, t, c.id);
      const year = yearIST();
      const n = q('INSERT INTO order_counters(year,last) VALUES(?,1) ON CONFLICT(year) DO UPDATE SET last=last+1 RETURNING last').get(year).last;
      const orderId = `AK-${year}-${String(n).padStart(6, '0')}`;
      q('INSERT INTO orders(id,customer_id,service,size,quantity,needed_by,details,status,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(orderId, c.id, service, String(b.size || '').slice(0, 80) || null, qty, neededBy, String(b.details || '').slice(0, 2000) || null, 'Enquiry Received', 'website_quote_form', t, t);
      q('INSERT INTO order_status_history(order_id,from_status,to_status,note,changed_by,created_at) VALUES(?,?,?,?,?,?)').run(orderId, null, 'Enquiry Received', 'Created from website enquiry', 'customer', t);
      const cr = q('INSERT INTO consent_records(customer_id,order_id,consent_type,status,consent_version,consent_text,source,ip,user_agent,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
      cr.run(c.id, orderId, 'operational', 'granted', D.CONSENT_VERSION, D.OPERATIONAL_TEXT, 'website_quote_form', meta.ip, meta.ua, t);
      if (b.consent_promotional === true) {
        cr.run(c.id, orderId, 'promotional', 'granted', D.CONSENT_VERSION, D.PROMOTIONAL_TEXT, 'website_quote_form', meta.ip, meta.ua, t);
        q('UPDATE customers SET promo_consent=1, promo_consent_updated_at=? WHERE id=?').run(t, c.id);
      } else {
        // Recorded for this order only. An existing customer's earlier opt-in is NOT overwritten.
        cr.run(c.id, orderId, 'promotional', 'not_given', D.CONSENT_VERSION, D.PROMOTIONAL_TEXT, 'website_quote_form', meta.ip, meta.ua, t);
      }
      return { orderId, customerId: c.id };
    });
    res.status(201).json({ order_id: out.orderId, status: 'Enquiry Received' });
  }));

  // Customer withdraws promotional consent (needs phone + one of their order IDs).
  app.post('/api/consent/withdraw', wrap((req, res) => {
    const phone = P.normaliseIndianMobile(req.body?.phone); const orderId = String(req.body?.order_id || '').trim().toUpperCase();
    if (!phone || !/^AK-\d{4}-\d{6}$/.test(orderId)) throw bad('Enter your mobile number and an Order ID (AK-YYYY-000001).');
    const c = q('SELECT c.* FROM customers c JOIN orders o ON o.customer_id=c.id WHERE c.phone=? AND o.id=?').get('+' + phone, orderId);
    if (!c) throw new HttpError(404, 'We could not match that mobile number and Order ID.');
    withdrawPromo(c.id, 'customer_self_service', req.ip, req.headers['user-agent']);
    res.json({ ok: true, message: 'Promotional messages stopped. You will still receive necessary updates about your orders.' });
  }));
  // Customer order tracking: Order ID + the mobile number used on the enquiry.
  const trackHits = new Map();
  app.post('/api/orders/track', wrap((req, res) => {
    const k = req.ip; const h = trackHits.get(k) || { n: 0, t: Date.now() };
    if (Date.now() - h.t > 10 * 60e3) { h.n = 0; h.t = Date.now(); }
    if (++h.n > 30) throw new HttpError(429, 'Too many lookups. Please try again in a few minutes.');
    trackHits.set(k, h);
    const phone = P.normaliseIndianMobile(req.body?.phone); const id = String(req.body?.order_id || '').trim().toUpperCase();
    if (!phone || !/^AK-\d{4}-\d{6}$/.test(id)) throw bad('Enter your Order ID and mobile number.');
    const o = q('SELECT o.* FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=? AND c.phone=?').get(id, '+' + phone);
    if (!o) throw new HttpError(404, 'No order matches that Order ID and mobile number.');
    const paid = q('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE order_id=?').get(o.id).s;
    res.json({ order_id: o.id, service: o.service, status: o.status, stage_index: D.ORDER_STAGES.indexOf(o.status), total_stages: D.ORDER_STAGES.length - 1,
      quotation_amount: o.quotation_amount, amount_paid: paid, artwork_status: o.artwork_status, production_progress: o.production_progress, fulfilment: o.fulfilment, created_at: o.created_at,
      history: q('SELECT to_status status, created_at at FROM order_status_history WHERE order_id=? ORDER BY id').all(o.id) });
  }));
  function withdrawPromo(customerId, source, ip = null, ua = null) {
    const t = nowISO();
    D.tx(db, () => {
      q('UPDATE customers SET promo_consent=0, promo_consent_updated_at=? WHERE id=?').run(t, customerId);
      q('INSERT INTO consent_records(customer_id,order_id,consent_type,status,consent_version,consent_text,source,ip,user_agent,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(customerId, null, 'promotional', 'withdrawn', D.CONSENT_VERSION, D.PROMOTIONAL_TEXT, source, ip, ua ? String(ua).slice(0, 300) : null, t);
    });
  }

  // Delivery-report webhooks (protected by WEBHOOK_SECRET).
  const mapDlr = (s) => { s = String(s || '').toLowerCase(); if (['delivered', 'read', '1'].includes(s)) return 'delivered'; if (['failed', 'rejected', 'undelivered', 'ndnc', '2', '16'].includes(s)) return 'failed'; if (s === 'sent') return 'sent'; return null; };
  function applyDlr(pmid, status, err) {
    if (!pmid || !status) return 0;
    const r = q('UPDATE communications SET status=?, error=COALESCE(?,error), updated_at=? WHERE provider_message_id=? AND status IN (\'pending\',\'sent\')').run(status, err || null, nowISO(), String(pmid));
    q('UPDATE review_requests SET status=?, updated_at=? WHERE communication_id IN (SELECT id FROM communications WHERE provider_message_id=?)').run(cap(status), nowISO(), String(pmid));
    return r.changes;
  }
  const hook = (req, res, next) => (process.env.WEBHOOK_SECRET && req.query.secret === process.env.WEBHOOK_SECRET ? next() : next(new HttpError(403, 'Forbidden')));
  app.post('/api/webhooks/sms-dlr', hook, (req, res) => {
    const items = Array.isArray(req.body) ? req.body : (req.body?.data || [req.body]);
    let n = 0; for (const it of items) n += applyDlr(it.requestId || it.request_id || it.id, mapDlr(it.status || it.desc), it.description);
    res.json({ updated: n });
  });
  app.get('/api/webhooks/whatsapp', (req, res) => (req.query['hub.verify_token'] && req.query['hub.verify_token'] === process.env.WA_VERIFY_TOKEN ? res.send(req.query['hub.challenge']) : res.sendStatus(403)));
  app.post('/api/webhooks/whatsapp', hook, (req, res) => {
    let n = 0;
    for (const e of req.body?.entry || []) for (const ch of e.changes || []) for (const s of ch.value?.statuses || []) n += applyDlr(s.id, mapDlr(s.status), s.errors?.[0]?.title);
    res.json({ updated: n });
  });

  // ---------- admin: overview + settings ----------
  const A = express.Router(); A.use(auth); app.use('/api/admin', A);
  A.get('/overview', (req, res) => {
    const c = (sql, ...a) => q(sql).get(...a).c;
    res.json({
      providers: providerStatus(),
      counts: {
        customers: c('SELECT COUNT(*) c FROM customers'), promo_opted_in: c('SELECT COUNT(*) c FROM customers WHERE promo_consent=1'),
        active_orders: c("SELECT COUNT(*) c FROM orders WHERE status NOT IN ('Order Completed','Cancelled')"), orders_total: c('SELECT COUNT(*) c FROM orders'),
        upcoming_events_30d: upcomingEvents(30).length,
        messages_delivered: c("SELECT COUNT(*) c FROM communications WHERE status='delivered'"), messages_failed: c("SELECT COUNT(*) c FROM communications WHERE status='failed'")
      },
      order_stages: D.ORDER_STAGES, recent_orders: q('SELECT o.id,o.service,o.status,o.updated_at,c.name FROM orders o JOIN customers c ON c.id=o.customer_id ORDER BY o.updated_at DESC LIMIT 6').all()
    });
  });
  const SETTING_KEYS = ['google_rating', 'google_review_count', 'google_rating_verified_at', 'google_review_url', 'google_maps_url', 'social_facebook', 'social_instagram', 'social_whatsapp', 'notify_on_status_change', 'default_reminder_template_id'];
  A.get('/settings', (req, res) => res.json({ settings: Object.fromEntries(SETTING_KEYS.map((k) => [k, getSetting(k)])), providers: providerStatus() }));
  A.put('/settings', (req, res) => {
    const b = req.body || {};
    for (const k of SETTING_KEYS) if (k in b) {
      let v = String(b[k] ?? '').trim();
      if (k === 'google_rating' && v && !(Number(v) >= 1 && Number(v) <= 5)) throw bad('Google rating must be between 1.0 and 5.0.');
      if (k === 'google_review_count' && v && !/^\d+$/.test(v)) throw bad('Review count must be a whole number.');
      if (/^(social_|google_.*url)/.test(k) && v && !/^https:\/\//.test(v)) throw bad(`${k} must be an https:// link.`);
      setSetting(k, v);
    }
    if ((String(b.google_rating || '').trim() || String(b.google_review_count || '').trim()) && !String(b.google_rating_verified_at || '').trim()) setSetting('google_rating_verified_at', todayIST());
    res.json({ ok: true });
  });

  // ---------- admin: customers, consent, comms ----------
  A.get('/customers', (req, res) => {
    const s = `%${String(req.query.q || '').trim()}%`;
    res.json(q(`SELECT c.*, (SELECT COUNT(*) FROM orders o WHERE o.customer_id=c.id) orders,
      (SELECT COUNT(*) FROM orders o WHERE o.customer_id=c.id AND o.status='Order Completed') completed_orders
      FROM customers c WHERE c.name LIKE ? OR c.phone LIKE ? ORDER BY c.updated_at DESC LIMIT 500`).all(s, s));
  });
  A.get('/customers/:id', (req, res) => {
    const c = customerById(req.params.id); if (!c) throw new HttpError(404, 'Customer not found');
    res.json({ customer: c, orders: q('SELECT id,service,status,created_at FROM orders WHERE customer_id=? ORDER BY created_at DESC').all(c.id),
      consents: q('SELECT * FROM consent_records WHERE customer_id=? ORDER BY id DESC').all(c.id),
      events: q('SELECT e.*, t.name type_name FROM customer_events e JOIN event_types t ON t.id=e.event_type_id WHERE customer_id=? ORDER BY event_date').all(c.id),
      communications: q('SELECT * FROM communications WHERE customer_id=? ORDER BY id DESC LIMIT 200').all(c.id) });
  });
  A.patch('/customers/:id', (req, res) => {
    const c = customerById(req.params.id); if (!c) throw new HttpError(404, 'Customer not found');
    const b = req.body || {};
    if (b.category != null) q('UPDATE customers SET category=?, updated_at=? WHERE id=?').run(String(b.category).slice(0, 40), nowISO(), c.id);
    if (b.preferred_channel != null) { if (!['sms', 'whatsapp'].includes(b.preferred_channel)) throw bad('Channel must be sms or whatsapp'); q('UPDATE customers SET preferred_channel=?, updated_at=? WHERE id=?').run(b.preferred_channel, nowISO(), c.id); }
    if (b.withdraw_promotional === true && c.promo_consent) withdrawPromo(c.id, `admin:${req.admin} (customer request)`);
    res.json({ ok: true, customer: customerById(c.id) });
  });
  A.get('/consents', (req, res) => res.json(q('SELECT r.*, c.name, c.phone FROM consent_records r JOIN customers c ON c.id=r.customer_id ORDER BY r.id DESC LIMIT 1000').all()));
  A.get('/communications', (req, res) => {
    const p = String(req.query.purpose || '');
    res.json(q(`SELECT m.*, c.name FROM communications m LEFT JOIN customers c ON c.id=m.customer_id ${p ? 'WHERE m.purpose=?' : ''} ORDER BY m.id DESC LIMIT 1000`).all(...(p ? [p] : [])));
  });

  // ---------- admin: orders ----------
  const orderRow = (id) => q('SELECT o.*, c.name, c.phone, c.preferred_channel FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=?').get(id);
  A.get('/orders', (req, res) => {
    const s = `%${String(req.query.q || '').trim()}%`; const st = String(req.query.status || '');
    res.json(q(`SELECT o.id,o.service,o.status,o.quotation_amount,o.production_progress,o.fulfilment,o.created_at,o.updated_at,c.name,c.phone,
      (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.order_id=o.id) paid
      FROM orders o JOIN customers c ON c.id=o.customer_id WHERE (o.id LIKE ? OR c.name LIKE ? OR c.phone LIKE ? OR o.service LIKE ?) ${st ? 'AND o.status=?' : ''}
      ORDER BY o.created_at DESC LIMIT 500`).all(s, s, s, s, ...(st ? [st] : [])));
  });
  A.get('/orders/:id', (req, res) => {
    const o = orderRow(req.params.id); if (!o) throw new HttpError(404, 'Order not found');
    res.json({ order: o, history: q('SELECT * FROM order_status_history WHERE order_id=? ORDER BY id').all(o.id), payments: q('SELECT * FROM payments WHERE order_id=? ORDER BY id').all(o.id),
      consents: q('SELECT * FROM consent_records WHERE order_id=? ORDER BY id').all(o.id), communications: q('SELECT * FROM communications WHERE order_id=? OR (customer_id=? AND order_id IS NULL) ORDER BY id DESC LIMIT 100').all(o.id, o.customer_id) });
  });
  A.patch('/orders/:id', wrap(async (req, res) => {
    const o = orderRow(req.params.id); if (!o) throw new HttpError(404, 'Order not found');
    const b = req.body || {}; const t = nowISO(); const sets = []; const vals = [];
    const set = (col, v) => { sets.push(`${col}=?`); vals.push(v); };
    if ('quotation_amount' in b) { const v = b.quotation_amount === '' || b.quotation_amount == null ? null : Number(b.quotation_amount); if (v !== null && !(v >= 0)) throw bad('Invalid quotation amount'); set('quotation_amount', v); }
    if ('artwork_status' in b) { if (!['Not submitted', 'Awaiting approval', 'Changes requested', 'Approved'].includes(b.artwork_status)) throw bad('Invalid artwork status'); set('artwork_status', b.artwork_status); }
    if ('artwork_note' in b) set('artwork_note', String(b.artwork_note || '').slice(0, 1000));
    if ('production_progress' in b) { const v = Number(b.production_progress); if (!(v >= 0 && v <= 100)) throw bad('Progress must be 0–100'); set('production_progress', Math.round(v)); }
    if ('fulfilment' in b) { if (!['pickup', 'delivery'].includes(b.fulfilment)) throw bad('Fulfilment must be pickup or delivery'); set('fulfilment', b.fulfilment); }
    if ('delivery_address' in b) set('delivery_address', String(b.delivery_address || '').slice(0, 500));
    let changed = null;
    if (b.status && b.status !== o.status) {
      if (!D.ORDER_STAGES.includes(b.status)) throw bad('Unknown order status');
      if (o.status === 'Cancelled' || o.status === 'Order Completed') throw bad(`Order is already "${o.status}".`);
      if (b.status === 'Out for Delivery' && (b.fulfilment || o.fulfilment) !== 'delivery') throw bad('Set fulfilment to delivery before marking Out for Delivery.');
      set('status', b.status); changed = b.status;
    }
    if (sets.length) { set('updated_at', t); q(`UPDATE orders SET ${sets.join(',')} WHERE id=?`).run(...vals, o.id); }
    let notification = null;
    if (changed) {
      q('INSERT INTO order_status_history(order_id,from_status,to_status,note,changed_by,created_at) VALUES(?,?,?,?,?,?)').run(o.id, o.status, changed, String(b.note || '').slice(0, 500) || null, req.admin, t);
      if (getSetting('notify_on_status_change') === '1') {
        const tpl = q("SELECT * FROM sms_templates WHERE enabled=1 AND category='service' AND trigger_status=? AND channel=?").get(changed, o.preferred_channel) || q("SELECT * FROM sms_templates WHERE enabled=1 AND category='service' AND trigger_status=?").get(changed);
        if (tpl) notification = await sendMessage({ customer: customerById(o.customer_id), template: tpl, purpose: 'order_update', orderId: o.id, vars: { name: o.name, order_id: o.id, status: changed, service: o.service, amount: b.quotation_amount ?? o.quotation_amount ?? '' } });
        else notification = { status: 'not_sent', error: `No enabled service template is linked to "${changed}".` };
      }
    }
    res.json({ ok: true, order: orderRow(o.id), notification });
  }));
  A.post('/orders/:id/payments', (req, res) => {
    const o = orderRow(req.params.id); if (!o) throw new HttpError(404, 'Order not found');
    const b = req.body || {}; const amt = Number(b.amount);
    if (!['advance', 'balance'].includes(b.kind)) throw bad('Payment type must be advance or balance');
    if (!(amt > 0)) throw bad('Amount must be greater than zero');
    if (!['Cash', 'UPI', 'Bank transfer', 'Card', 'Cheque'].includes(b.method)) throw bad('Choose a payment method');
    if (b.method !== 'Cash' && !String(b.reference || '').trim()) throw bad('A payment reference is required for non-cash payments.');
    const t = nowISO(); const verified = b.verified === true;
    q('INSERT INTO payments(order_id,kind,amount,method,reference,verified,verified_by,verified_at,note,recorded_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(o.id, b.kind, amt, b.method, String(b.reference || '').slice(0, 100) || null, verified ? 1 : 0, verified ? req.admin : null, verified ? t : null, String(b.note || '').slice(0, 300) || null, req.admin, t);
    res.status(201).json({ ok: true, payments: q('SELECT * FROM payments WHERE order_id=?').all(o.id) });
  });
  A.patch('/payments/:id/verify', (req, res) => {
    const r = q('UPDATE payments SET verified=1, verified_by=?, verified_at=? WHERE id=? AND verified=0').run(req.admin, nowISO(), req.params.id);
    if (!r.changes) throw new HttpError(404, 'Payment not found or already verified'); res.json({ ok: true });
  });

  // ---------- admin: templates ----------
  const tplFields = ['name', 'category', 'channel', 'body', 'variables', 'dlt_template_id', 'sender_id', 'provider_template_id', 'wa_template_name', 'wa_language', 'trigger_status', 'enabled'];
  function cleanTemplate(b) {
    const o = {}; for (const k of tplFields) if (k in b) o[k] = b[k];
    if ('variables' in o) { const v = Array.isArray(o.variables) ? o.variables : String(o.variables || '').split(',').map((s) => s.trim()).filter(Boolean); if (!v.every((x) => /^\w+$/.test(x))) throw bad('Variables must be simple names like name, order_id'); o.variables = JSON.stringify(v); }
    if ('enabled' in o) o.enabled = o.enabled ? 1 : 0;
    if (o.trigger_status && !D.ORDER_STAGES.includes(o.trigger_status)) throw bad('Unknown trigger status');
    if (o.category && !['service', 'promotional', 'otp'].includes(o.category)) throw bad('Invalid category');
    if (o.channel && !['sms', 'whatsapp'].includes(o.channel)) throw bad('Invalid channel');
    if (o.sender_id && !/^[A-Z]{6}$/.test(o.sender_id)) throw bad('DLT sender ID (header) must be 6 capital letters.');
    return o;
  }
  A.get('/templates', (req, res) => res.json(q('SELECT * FROM sms_templates ORDER BY id DESC').all()));
  A.post('/templates', (req, res) => {
    const o = cleanTemplate(req.body || {}); if (!o.name || !o.body || !o.category || !o.channel) throw bad('Name, category, channel and body are required');
    const t = nowISO(); const r = q('INSERT INTO sms_templates(name,category,channel,body,variables,dlt_template_id,sender_id,provider_template_id,wa_template_name,wa_language,trigger_status,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(o.name, o.category, o.channel, o.body, o.variables || '[]', o.dlt_template_id || null, o.sender_id || null, o.provider_template_id || null, o.wa_template_name || null, o.wa_language || 'en', o.trigger_status || null, o.enabled ?? 1, t, t);
    res.status(201).json(q('SELECT * FROM sms_templates WHERE id=?').get(r.lastInsertRowid));
  });
  A.put('/templates/:id', (req, res) => {
    const o = cleanTemplate(req.body || {}); const keys = Object.keys(o); if (!keys.length) throw bad('Nothing to update');
    const r = q(`UPDATE sms_templates SET ${keys.map((k) => k + '=?').join(',')}, updated_at=? WHERE id=?`).run(...keys.map((k) => (o[k] === '' ? null : o[k])), nowISO(), req.params.id);
    if (!r.changes) throw new HttpError(404, 'Template not found'); res.json(q('SELECT * FROM sms_templates WHERE id=?').get(req.params.id));
  });
  const templateReady = (tpl) => (tpl.channel === 'sms' ? (tpl.dlt_template_id && tpl.sender_id && tpl.provider_template_id) : tpl.wa_template_name);

  // ---------- admin: campaigns (OTP-gated) ----------
  const CATEGORIES = () => q('SELECT DISTINCT category FROM customers ORDER BY 1').all().map((r) => r.category);
  function eligible(audience) {
    const cats = Array.isArray(audience?.categories) ? audience.categories.filter(Boolean) : [];
    const where = ['promo_consent=1']; const args = [];
    if (cats.length) { where.push(`category IN (${cats.map(() => '?').join(',')})`); args.push(...cats); }
    if (audience?.has_completed_order) where.push("EXISTS (SELECT 1 FROM orders o WHERE o.customer_id=customers.id AND o.status='Order Completed')");
    return q(`SELECT * FROM customers WHERE ${where.join(' AND ')}`).all(...args);
  }
  A.get('/campaigns/meta', (req, res) => res.json({ categories: CATEGORIES(), providers: providerStatus(), in_promo_window: inPromoWindow() }));
  A.post('/campaigns/preview', (req, res) => {
    const list = eligible(req.body?.audience || {}); const total = q('SELECT COUNT(*) c FROM customers').get().c;
    res.json({ eligible: list.length, excluded_no_consent: q('SELECT COUNT(*) c FROM customers WHERE promo_consent=0').get().c, total_customers: total });
  });
  const campaignStats = (id) => q("SELECT COUNT(*) attempted, SUM(status IN ('sent','delivered')) successful, SUM(status='delivered') delivered, SUM(status='failed') failed, SUM(status='pending') pending, SUM(status='not_sent') not_sent FROM communications WHERE campaign_id=?").get(id);
  A.get('/campaigns', (req, res) => res.json(q('SELECT c.*, t.name template_name FROM campaigns c JOIN sms_templates t ON t.id=c.template_id ORDER BY c.id DESC').all().map((c) => ({ ...c, audience: JSON.parse(c.audience), stats: campaignStats(c.id) }))));
  A.post('/campaigns', (req, res) => {
    const b = req.body || {}; const tpl = q('SELECT * FROM sms_templates WHERE id=?').get(b.template_id);
    if (!b.name) throw bad('Campaign name is required');
    if (!tpl || tpl.category !== 'promotional') throw bad('Choose an approved promotional template');
    const r = q('INSERT INTO campaigns(name,template_id,channel,audience,kind,promotion_id,status,eligible_count,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(String(b.name).slice(0, 100), tpl.id, tpl.channel, JSON.stringify(b.audience || {}), b.promotion_id ? 'promotion' : 'sms', b.promotion_id || null, 'draft', eligible(b.audience || {}).length, req.admin, nowISO());
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });
  const otpHash = (code, ref) => crypto.createHmac('sha256', otpPepper).update(`${ref}:${code}`).digest('hex');
  A.post('/campaigns/:id/request-otp', wrap(async (req, res) => {
    const c = q('SELECT * FROM campaigns WHERE id=?').get(req.params.id); if (!c) throw new HttpError(404, 'Campaign not found');
    if (c.status !== 'draft') throw bad('Only draft campaigns can be executed.');
    const ps = providerStatus();
    if (!ps.otp.configured) throw new HttpError(503, 'OTP verification is not available: ' + ps.otp.missing.join(', ') + ' not configured.', { missing: ps.otp.missing });
    if (!ps[c.channel].configured) throw new HttpError(503, `${c.channel.toUpperCase()} provider is not configured, so bulk sending is disabled.`);
    const last = q("SELECT created_at FROM otps WHERE purpose='campaign' AND ref_id=? ORDER BY id DESC LIMIT 1").get(String(c.id));
    if (last && Date.now() - Date.parse(last.created_at) < 60e3) throw new HttpError(429, 'Please wait 60 seconds before requesting another OTP.');
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    const otpTpl = { channel: 'sms', body: 'OTP {{otp}}', provider_template_id: process.env.OTP_TEMPLATE_ID, dlt_template_id: process.env.OTP_DLT_TEMPLATE_ID, sender_id: process.env.OTP_SENDER_ID };
    const to = P.normaliseIndianMobile(process.env.ADMIN_OTP_MOBILE);
    try { await P.sms.send({ template: otpTpl, to, vars: { otp: code, campaign: c.name.slice(0, 20) } }); }
    catch (e) { throw new HttpError(502, 'Could not send OTP: ' + e.message); }
    q("UPDATE otps SET consumed_at=? WHERE purpose='campaign' AND ref_id=? AND consumed_at IS NULL").run(nowISO(), String(c.id));
    q('INSERT INTO otps(purpose,ref_id,code_hash,expires_at,created_at) VALUES(?,?,?,?,?)').run('campaign', String(c.id), otpHash(code, c.id), new Date(Date.now() + 5 * 60e3).toISOString(), nowISO());
    res.json({ ok: true, sent_to: '******' + to.slice(-4), expires_in_seconds: 300, max_attempts: 3 });
  }));
  A.post('/campaigns/:id/execute', wrap(async (req, res) => {
    const c = q('SELECT * FROM campaigns WHERE id=?').get(req.params.id); if (!c) throw new HttpError(404, 'Campaign not found');
    if (c.status !== 'draft') throw bad('Campaign already executed.');
    const otp = q("SELECT * FROM otps WHERE purpose='campaign' AND ref_id=? AND consumed_at IS NULL ORDER BY id DESC LIMIT 1").get(String(c.id));
    if (!otp) throw bad('Request an OTP first.');
    if (otp.expires_at < nowISO()) { q('UPDATE otps SET consumed_at=? WHERE id=?').run(nowISO(), otp.id); throw bad('OTP expired. Request a new one.'); }
    if (otp.attempts >= otp.max_attempts) throw bad('Too many wrong attempts. Request a new OTP.');
    const ok = /^\d{6}$/.test(String(req.body?.otp || '')) && crypto.timingSafeEqual(Buffer.from(otpHash(String(req.body.otp), c.id), 'hex'), Buffer.from(otp.code_hash, 'hex'));
    if (!ok) { q('UPDATE otps SET attempts=attempts+1 WHERE id=?').run(otp.id); throw bad(`Incorrect OTP. ${otp.max_attempts - otp.attempts - 1} attempt(s) left.`); }
    q('UPDATE otps SET consumed_at=? WHERE id=?').run(nowISO(), otp.id);
    if (!inPromoWindow()) throw bad('Promotional messages can only be sent between 9:00 AM and 9:00 PM IST.');
    const tpl = q('SELECT * FROM sms_templates WHERE id=?').get(c.template_id);
    if (!templateReady(tpl)) throw bad('Template is missing DLT / provider IDs.');
    const promo = c.promotion_id ? q('SELECT * FROM promotions WHERE id=?').get(c.promotion_id) : null;
    q("UPDATE campaigns SET status='running', executed_at=? WHERE id=?").run(nowISO(), c.id);
    const list = eligible(JSON.parse(c.audience));
    for (const cu of list) await sendMessage({ customer: cu, template: tpl, purpose: 'campaign', campaignId: c.id, requirePromo: true, vars: { name: cu.name, offer: promo?.offer_text || '', title: promo?.title || '' } });
    q("UPDATE campaigns SET status='completed', finished_at=?, eligible_count=? WHERE id=?").run(nowISO(), list.length, c.id);
    res.json({ ok: true, stats: campaignStats(c.id) });
  }));

  // ---------- admin: Google review requests ----------
  A.get('/review-requests', (req, res) => res.json(q('SELECT r.*, c.name, c.phone, m.error comm_error FROM review_requests r JOIN customers c ON c.id=r.customer_id LEFT JOIN communications m ON m.id=r.communication_id ORDER BY r.id DESC LIMIT 500').all()));
  A.post('/review-requests', wrap(async (req, res) => {
    const ids = (req.body?.customer_ids || []).map(Number).filter(Boolean); const tpl = q('SELECT * FROM sms_templates WHERE id=?').get(req.body?.template_id);
    if (!ids.length) throw bad('Select at least one customer.');
    if (!tpl || tpl.category !== 'service') throw bad('Choose a service-category review-request template.');
    const reviewUrl = getSetting('google_review_url'); if (!reviewUrl) throw bad('Set the Google review link in Google Review Management first.');
    if (!P.channel(tpl.channel).isConfigured()) throw new HttpError(503, `${tpl.channel.toUpperCase()} provider is not configured. No review requests were created.`);
    if (!templateReady(tpl)) throw bad('Template is missing DLT / provider IDs.');
    const out = [];
    for (const id of ids) {
      const cu = customerById(id); if (!cu) continue;
      const done = q("SELECT id FROM orders WHERE customer_id=? AND status IN ('Order Completed','Delivered or Collected') ORDER BY updated_at DESC LIMIT 1").get(id);
      const t = nowISO();
      const rr = q('INSERT INTO review_requests(customer_id,order_id,channel,status,requested_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, done?.id || null, tpl.channel, 'Pending', req.admin, t, t);
      const rid = Number(rr.lastInsertRowid);
      if (!done) { q('UPDATE review_requests SET status=?, error=? WHERE id=?').run('Failed', 'Customer has no completed order', rid); out.push({ customer_id: id, status: 'Failed' }); continue; }
      const m = await sendMessage({ customer: cu, template: tpl, purpose: 'review_request', orderId: done.id, reviewRequestId: rid, vars: { name: cu.name, review_link: reviewUrl, order_id: done.id } });
      const st = { sent: 'Sent', delivered: 'Delivered', failed: 'Failed', not_sent: 'Failed', pending: 'Pending' }[m.status];
      q('UPDATE review_requests SET status=?, communication_id=?, error=?, updated_at=? WHERE id=?').run(st, m.id, m.error || null, nowISO(), rid);
      out.push({ customer_id: id, status: st, error: m.error });
    }
    res.json({ results: out });
  }));

  // ---------- admin: event types, customer events, reminders ----------
  A.get('/event-types', (req, res) => res.json(q('SELECT * FROM event_types ORDER BY is_default DESC, name').all().map((t) => ({ ...t, intervals: JSON.parse(t.intervals) }))));
  const cleanIntervals = (v) => { const a = (Array.isArray(v) ? v : String(v).split(',')).map((x) => Number(String(x).trim())).filter((x) => x !== 0 || true); if (!a.length || !a.every((x) => Number.isInteger(x) && x >= 0 && x <= 365)) throw bad('Intervals must be whole days between 0 and 365, e.g. 30,15,7'); return JSON.stringify([...new Set(a)].sort((x, y) => y - x)); };
  A.post('/event-types', (req, res) => {
    const b = req.body || {}; if (!String(b.name || '').trim()) throw bad('Name is required'); const t = nowISO();
    try { const r = q('INSERT INTO event_types(name,recurring,enabled,intervals,template_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(String(b.name).trim().slice(0, 60), b.recurring ? 1 : 0, b.enabled === false ? 0 : 1, cleanIntervals(b.intervals ?? '30,15,7'), b.template_id || null, t, t); res.status(201).json({ id: Number(r.lastInsertRowid) }); }
    catch (e) { if (/UNIQUE/.test(e.message)) throw bad('An event type with this name already exists'); throw e; }
  });
  A.put('/event-types/:id', (req, res) => {
    const b = req.body || {}; const sets = []; const v = [];
    if ('name' in b) { sets.push('name=?'); v.push(String(b.name).trim().slice(0, 60)); }
    if ('recurring' in b) { sets.push('recurring=?'); v.push(b.recurring ? 1 : 0); }
    if ('enabled' in b) { sets.push('enabled=?'); v.push(b.enabled ? 1 : 0); }
    if ('intervals' in b) { sets.push('intervals=?'); v.push(cleanIntervals(b.intervals)); }
    if ('template_id' in b) { sets.push('template_id=?'); v.push(b.template_id || null); }
    if (!sets.length) throw bad('Nothing to update');
    const r = q(`UPDATE event_types SET ${sets.join(',')}, updated_at=? WHERE id=?`).run(...v, nowISO(), req.params.id); if (!r.changes) throw new HttpError(404, 'Not found'); res.json({ ok: true });
  });
  A.post('/customers/:id/events', (req, res) => {
    const b = req.body || {}; const c = customerById(req.params.id); if (!c) throw new HttpError(404, 'Customer not found');
    if (!q('SELECT 1 FROM event_types WHERE id=?').get(b.event_type_id)) throw bad('Choose an event type');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.event_date || ''))) throw bad('Event date is required');
    const t = nowISO(); const r = q('INSERT INTO customer_events(customer_id,event_type_id,event_date,label,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(c.id, b.event_type_id, b.event_date, String(b.label || '').slice(0, 80) || null, String(b.notes || '').slice(0, 300) || null, t, t);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });
  A.put('/customer-events/:id', (req, res) => {
    const b = req.body || {}; if (b.event_date && !/^\d{4}-\d{2}-\d{2}$/.test(b.event_date)) throw bad('Invalid date');
    const r = q('UPDATE customer_events SET event_type_id=COALESCE(?,event_type_id), event_date=COALESCE(?,event_date), label=COALESCE(?,label), notes=COALESCE(?,notes), updated_at=? WHERE id=?').run(b.event_type_id ?? null, b.event_date ?? null, b.label ?? null, b.notes ?? null, nowISO(), req.params.id);
    if (!r.changes) throw new HttpError(404, 'Not found'); res.json({ ok: true });
  });
  A.delete('/customer-events/:id', (req, res) => { q('DELETE FROM reminder_log WHERE customer_event_id=?').run(req.params.id); q('DELETE FROM customer_events WHERE id=?').run(req.params.id); res.json({ ok: true }); });

  const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  function nextOccurrence(ev, fromYmd) {
    if (!ev.recurring) return ev.event_date >= fromYmd ? ev.event_date : null;
    const [, m, d] = ev.event_date.split('-'); const y0 = Number(fromYmd.slice(0, 4));
    for (const y of [y0, y0 + 1]) { const dd = m === '02' && d === '29' && !isLeap(y) ? '28' : d; const s = `${y}-${m}-${dd}`; if (s >= fromYmd) return s; }
    return null;
  }
  const eventsSql = 'SELECT e.*, t.name type_name, t.recurring, t.intervals, t.enabled type_enabled, t.template_id, c.name, c.phone, c.promo_consent, c.preferred_channel FROM customer_events e JOIN event_types t ON t.id=e.event_type_id JOIN customers c ON c.id=e.customer_id';
  function upcomingEvents(days) {
    const today = todayIST(); const lim = addDays(today, days);
    return q(eventsSql).all().map((e) => ({ ...e, next: nextOccurrence(e, today) })).filter((e) => e.next && e.next <= lim).sort((a, b) => a.next.localeCompare(b.next));
  }
  A.get('/customer-events', (req, res) => res.json(q(eventsSql + ' ORDER BY e.event_date').all().map((e) => ({ ...e, next: nextOccurrence(e, todayIST()), intervals: JSON.parse(e.intervals) }))));

  let running = false;
  async function runReminders(trigger = 'schedule') {
    if (running) throw new HttpError(409, 'A reminder run is already in progress.');
    running = true; const today = todayIST();
    const run = q('INSERT INTO reminder_runs(run_date,trigger,started_at) VALUES(?,?,?)').run(today, trigger, nowISO()); const runId = Number(run.lastInsertRowid);
    const tally = { candidates: 0, sent: 0, skipped: 0, failed: 0 };
    try {
      const defTpl = getSetting('default_reminder_template_id');
      for (const ev of q(eventsSql + ' WHERE t.enabled=1').all()) {
        const occ = nextOccurrence(ev, today); if (!occ) continue;
        for (const days of JSON.parse(ev.intervals)) {
          if (addDays(occ, -days) !== today) continue;
          tally.candidates++;
          let logId;
          try { logId = Number(q('INSERT INTO reminder_log(run_id,customer_event_id,interval_days,occurrence_date,status,created_at) VALUES(?,?,?,?,?,?)').run(runId, ev.id, days, occ, 'pending', nowISO()).lastInsertRowid); }
          catch (e) { if (/UNIQUE/.test(e.message)) { tally.skipped++; continue; } throw e; } // duplicate prevention
          const done = (status, err, commId = null) => { q('UPDATE reminder_log SET status=?, error=?, communication_id=? WHERE id=?').run(status, err || null, commId, logId); tally[status === 'sent' ? 'sent' : status === 'skipped' ? 'skipped' : 'failed']++; };
          const cu = customerById(ev.customer_id);
          if (!cu.promo_consent) { done('skipped', 'No active promotional consent'); continue; }
          const tpl = q('SELECT * FROM sms_templates WHERE id=? AND enabled=1').get(ev.template_id || defTpl);
          if (!tpl) { done('failed', 'No reminder template configured for this event type'); continue; }
          if (!P.channel(tpl.channel).isConfigured()) { done('failed', `${tpl.channel.toUpperCase()} provider not configured`); continue; }
          const m = await sendMessage({ customer: cu, template: tpl, purpose: 'reminder', reminderLogId: logId, requirePromo: true, vars: { name: cu.name, event: ev.label || ev.type_name, date: occ, days } });
          done(m.status === 'sent' ? 'sent' : m.status === 'not_sent' ? 'skipped' : 'failed', m.error, m.id);
        }
      }
      q('UPDATE reminder_runs SET finished_at=?, candidates=?, sent=?, skipped=?, failed=? WHERE id=?').run(nowISO(), tally.candidates, tally.sent, tally.skipped, tally.failed, runId);
    } catch (e) { q('UPDATE reminder_runs SET finished_at=?, error=? WHERE id=?').run(nowISO(), e.message, runId); throw e; }
    finally { running = false; }
    return { run_id: runId, ...tally };
  }
  A.post('/reminders/run', wrap(async (req, res) => res.json(await runReminders(`manual:${req.admin}`))));
  A.get('/reminders/runs', (req, res) => res.json(q('SELECT * FROM reminder_runs ORDER BY id DESC LIMIT 100').all()));
  A.get('/reminders/log', (req, res) => res.json(q('SELECT l.*, c.name, t.name type_name FROM reminder_log l JOIN customer_events e ON e.id=l.customer_event_id JOIN customers c ON c.id=e.customer_id JOIN event_types t ON t.id=e.event_type_id ORDER BY l.id DESC LIMIT 500').all()));
  A.get('/reminders/upcoming', (req, res) => res.json(upcomingEvents(Number(req.query.days) || 45)));

  // ---------- admin: promotions + social ----------
  const PROMO_KINDS = ['Festival Offer', 'Discount', 'Seasonal Promotion', 'Special Campaign'];
  function saveBanner(dataUrl) {
    const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '')); if (!m) throw bad('Banner must be a PNG, JPEG or WebP image');
    const buf = Buffer.from(m[2], 'base64'); if (buf.length > 5 * 1024 * 1024) throw bad('Banner must be under 5 MB');
    const sig = { png: (x) => x.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), jpeg: (x) => x[0] === 0xff && x[1] === 0xd8 && x[2] === 0xff, webp: (x) => x.subarray(0, 4).toString() === 'RIFF' && x.subarray(8, 12).toString() === 'WEBP' };
    if (!sig[m[1]](buf)) throw bad('The file content is not a valid ' + m[1].toUpperCase() + ' image.');
    const name = `promo-${crypto.randomBytes(8).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`; fs.writeFileSync(path.join(uploadsDir, name), buf); return name;
  }
  function cleanPromo(b) {
    const o = {};
    for (const k of ['title', 'description', 'offer_text']) if (k in b) o[k] = String(b[k] || '').slice(0, k === 'description' ? 1000 : 160);
    if ('kind' in b) { if (!PROMO_KINDS.includes(b.kind)) throw bad('Invalid promotion type'); o.kind = b.kind; }
    for (const k of ['start_date', 'end_date']) if (k in b) { if (!/^\d{4}-\d{2}-\d{2}$/.test(b[k])) throw bad('Start and end dates are required'); o[k] = b[k]; }
    if ('enabled' in b) o.enabled = b.enabled ? 1 : 0;
    if (b.banner_data_url) o.banner_file = saveBanner(b.banner_data_url);
    return o;
  }
  A.get('/promotions', (req, res) => res.json(q('SELECT * FROM promotions ORDER BY start_date DESC').all().map((p) => ({ ...p, banner_url: p.banner_file ? '/uploads/' + p.banner_file : null, posts: q('SELECT * FROM social_posts WHERE promotion_id=? ORDER BY id DESC').all(p.id) }))));
  A.post('/promotions', (req, res) => {
    const o = cleanPromo(req.body || {}); if (!o.title || !o.start_date || !o.end_date) throw bad('Title, start date and end date are required'); if (o.end_date < o.start_date) throw bad('End date must be after start date');
    const t = nowISO(); const r = q('INSERT INTO promotions(title,kind,description,offer_text,banner_file,start_date,end_date,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(o.title, o.kind || 'Festival Offer', o.description || null, o.offer_text || null, o.banner_file || null, o.start_date, o.end_date, o.enabled ?? 0, t, t);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });
  A.put('/promotions/:id', (req, res) => {
    const o = cleanPromo(req.body || {}); const k = Object.keys(o); if (!k.length) throw bad('Nothing to update');
    const r = q(`UPDATE promotions SET ${k.map((x) => x + '=?').join(',')}, updated_at=? WHERE id=?`).run(...k.map((x) => o[x]), nowISO(), req.params.id); if (!r.changes) throw new HttpError(404, 'Not found');
    const p = q('SELECT * FROM promotions WHERE id=?').get(req.params.id); if (p.end_date < p.start_date) throw bad('End date must be after start date'); res.json({ ok: true });
  });
  A.post('/promotions/:id/share-log', (req, res) => {
    const pl = String(req.body?.platform || ''); if (!['facebook', 'instagram', 'whatsapp'].includes(pl)) throw bad('Invalid platform');
    q('INSERT INTO social_posts(promotion_id,platform,mode,status,created_by,created_at) VALUES(?,?,?,?,?,?)').run(req.params.id, pl, 'manual_share_opened', 'Share window opened — not confirmed as published', req.admin, nowISO());
    res.json({ ok: true });
  });
  A.post('/promotions/:id/publish', wrap(async (req, res) => {
    const p = q('SELECT * FROM promotions WHERE id=?').get(req.params.id); if (!p) throw new HttpError(404, 'Not found');
    const pl = String(req.body?.platform || '');
    const ok = pl === 'facebook' ? P.meta.facebookConfigured() : pl === 'instagram' ? P.meta.instagramConfigured() : false;
    if (!ok) throw new HttpError(503, `Direct ${pl} publishing is not configured (needs Meta app permissions, ${pl === 'instagram' ? 'IG_USER_ID' : 'META_PAGE_ID'}, META_PAGE_TOKEN and PUBLIC_BASE_URL). Use manual sharing.`);
    if (!p.banner_file) throw bad('Upload a banner image first.');
    const caption = [p.title, p.offer_text, p.description, 'AK Digital Printing, Suranam · +91 95852 32399'].filter(Boolean).join('\n\n');
    const imageUrl = process.env.PUBLIC_BASE_URL.replace(/\/$/, '') + '/uploads/' + p.banner_file;
    try {
      const id = pl === 'facebook' ? await P.meta.publishFacebook({ imageUrl, caption }) : await P.meta.publishInstagram({ imageUrl, caption });
      q('INSERT INTO social_posts(promotion_id,platform,mode,status,external_id,created_by,created_at) VALUES(?,?,?,?,?,?,?)').run(p.id, pl, 'direct', 'Published', id, req.admin, nowISO());
      res.json({ ok: true, external_id: id });
    } catch (e) { q('INSERT INTO social_posts(promotion_id,platform,mode,status,error,created_by,created_at) VALUES(?,?,?,?,?,?,?)').run(p.id, pl, 'direct', 'Failed', e.message, req.admin, nowISO()); throw new HttpError(502, e.message); }
  }));

  // ---------- admin: gallery manager (real job photos) ----------
  const GAL_CATS = ['event', 'business', 'photo', 'print', 'community'];
  const cleanCats = (v) => { const a = (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).filter((x) => GAL_CATS.includes(x)); if (!a.length) throw bad('Choose at least one gallery category'); return [...new Set(a)].join(' '); };
  A.get('/gallery', (req, res) => res.json(q('SELECT * FROM gallery_items ORDER BY sort DESC, id DESC').all().map((g) => ({ ...g, image_url: '/uploads/' + g.image_file }))));
  A.post('/gallery', (req, res) => {
    const b = req.body || {}; if (!String(b.title || '').trim()) throw bad('Title is required'); const cats = cleanCats(b.categories);
    if (!b.image_data_url) throw bad('Choose a photo'); const file = saveBanner(b.image_data_url).replace(/^promo-/, 'promo-');
    const t = nowISO(); const r = q('INSERT INTO gallery_items(title,categories,image_file,enabled,sort,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(String(b.title).trim().slice(0, 80), cats, file, b.enabled === false ? 0 : 1, Number(b.sort) || 0, t, t);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });
  A.put('/gallery/:id', (req, res) => {
    const b = req.body || {}; const sets = []; const v = [];
    if ('title' in b) { sets.push('title=?'); v.push(String(b.title).trim().slice(0, 80)); }
    if ('categories' in b) { sets.push('categories=?'); v.push(cleanCats(b.categories)); }
    if ('enabled' in b) { sets.push('enabled=?'); v.push(b.enabled ? 1 : 0); }
    if ('sort' in b) { sets.push('sort=?'); v.push(Number(b.sort) || 0); }
    if (!sets.length) throw bad('Nothing to update');
    const r = q(`UPDATE gallery_items SET ${sets.join(',')}, updated_at=? WHERE id=?`).run(...v, nowISO(), req.params.id); if (!r.changes) throw new HttpError(404, 'Not found'); res.json({ ok: true });
  });
  A.delete('/gallery/:id', (req, res) => {
    const g = q('SELECT * FROM gallery_items WHERE id=?').get(req.params.id); if (!g) throw new HttpError(404, 'Not found');
    q('DELETE FROM gallery_items WHERE id=?').run(g.id); try { fs.unlinkSync(path.join(uploadsDir, g.image_file)); } catch (e) { /* already gone */ }
    res.json({ ok: true });
  });

  // ---------- static ----------
  const siteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');
  if (PROD && !/^https:\/\//.test(siteUrl)) console.warn('[ak] SITE_URL is not set to an https:// URL: canonical, Open Graph and sitemap URLs are omitted.');
  app.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /uploads/\n${siteUrl ? `Sitemap: ${siteUrl}/sitemap.xml\n` : ''}`));
  app.get('/sitemap.xml', (req, res) => {
    if (!siteUrl) return res.status(404).type('text/plain').send('SITE_URL not configured');
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${siteUrl}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url></urlset>\n`);
  });
  app.use('/uploads', express.static(uploadsDir, { maxAge: '7d', setHeaders: (res) => res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'") }));
  // Index page: inject absolute SEO URLs, and a CSP whose script-src lists the SHA-256 of each inline script.
  const indexFile = ['index.html', 'AK-Digital-Printing-Final.html'].map((f) => path.join(publicDir, f)).find((f) => fs.existsSync(f));
  let indexHtml = null; let csp = null;
  if (indexFile) {
    indexHtml = fs.readFileSync(indexFile, 'utf8');
    indexHtml = siteUrl ? indexHtml.split('%%SITE_URL%%').join(siteUrl) : indexHtml.replace(/<(?:link|meta)[^>]*%%SITE_URL%%[^>]*>\n?/g, '').split('%%SITE_URL%%').join('');
    const hashes = [...indexHtml.matchAll(/<script(?![^>]*type="application\/ld\+json")(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
    csp = ["default-src 'self'", `script-src 'self' ${hashes.join(' ')}`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'self'", 'frame-src https://www.google.com', "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"].join('; ');
  }
  const sendIndex = (req, res) => { res.setHeader('Content-Security-Policy', csp + (req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; upgrade-insecure-requests' : '')); res.setHeader('Cache-Control', 'no-cache'); res.type('html').send(indexHtml); };
  if (indexHtml) { app.get('/', sendIndex); app.get('/index.html', sendIndex); }
  if (fs.existsSync(publicDir)) app.use(express.static(publicDir, { index: false, setHeaders: (res, f) => { if (/[\\/]assets[\\/]/.test(f)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'); } }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    const st = err.status || 500; if (st >= 500 && st !== 503 && st !== 502) console.error(err);
    res.status(st).json({ error: st === 500 ? 'Server error' : err.message, ...(err.extra || {}) });
  });

  // ---------- scheduler: reminders once a day at 10:00 IST ----------
  let timer = null;
  function startScheduler() {
    const tick = async () => {
      const today = todayIST();
      if (hourIST() >= 10 && !q("SELECT 1 FROM reminder_runs WHERE run_date=? AND trigger='schedule'").get(today)) {
        try { const r = await runReminders('schedule'); console.log('[ak] reminders', r); } catch (e) { console.error('[ak] reminder run failed', e.message); }
      }
    };
    const housekeeping = () => {
      q('DELETE FROM sessions WHERE expires_at < ?').run(nowISO());
      const dir = process.env.BACKUP_DIR; if (!dir || hourIST() < 2) return;
      const today = todayIST(); const marker = path.join(dir, `.last-daily-${today}`);
      if (fs.existsSync(marker)) return;
      try { const f = D.backup(db, dir, 'daily'); fs.writeFileSync(marker, f); for (const m of fs.readdirSync(dir).filter((x) => x.startsWith('.last-daily-') && x !== path.basename(marker))) fs.unlinkSync(path.join(dir, m)); console.log('[ak] daily backup', f); }
      catch (e) { console.error('[ak] backup failed', e.message); }
    };
    timer = setInterval(() => { tick(); housekeeping(); }, 60e3); tick(); housekeeping();
  }
  return { app, db, runReminders, startScheduler, stop: () => clearInterval(timer) };
}

if (require.main === module) {
  const { app, db, startScheduler, stop } = createApp();
  const port = Number(process.env.PORT || 8787);
  const server = app.listen(port, process.env.HOST || '0.0.0.0', () => { console.log(`[ak] backend listening on http://localhost:${port} (timezone ${TZ})`); startScheduler(); });
  const shutdown = (sig) => { console.log(`[ak] ${sig}: shutting down`); stop(); server.close(() => { try { db.close(); } catch (e) { /* closed */ } process.exit(0); }); setTimeout(() => process.exit(1), 10e3).unref(); };
  process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
module.exports = { createApp, todayIST };
