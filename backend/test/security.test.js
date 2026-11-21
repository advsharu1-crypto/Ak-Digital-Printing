'use strict';
// Production-mode security tests (separate process: NODE_ENV=production set before load).
process.env.NODE_ENV = 'production'; process.env.SITE_URL = 'https://www.example-ak.in'; process.env.LOG_REQUESTS = '0';
process.env.ADMIN_USERNAME = 'admin'; process.env.ADMIN_PASSWORD = 'prod-test-password-123'; process.env.RL_ENQUIRIES = '3';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aksec-'));
fs.mkdirSync(path.join(tmp, 'pub'));
fs.writeFileSync(path.join(tmp, 'pub', 'index.html'), '<!DOCTYPE html><html><head><link rel="canonical" href="%%SITE_URL%%/"><script>window.A=1</script><script type="application/ld+json">{"url":"%%SITE_URL%%/"}</script></head><body></body></html>');
const { createApp } = require('../src/server');
const { app, db } = createApp({ dbFile: path.join(tmp, 'ak.db'), uploadsDir: path.join(tmp, 'up'), publicDir: path.join(tmp, 'pub') });
let base, server, token;
const call = async (method, url, body, headers = {}) => { const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, headers: r.headers, text: await r.text() }; };
test.before(async () => { server = app.listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

test('security headers + hash-based CSP on index; SITE_URL injected', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/); assert.doesNotMatch(csp.split(';').find((d) => d.trim().startsWith('script-src')), /unsafe/);
  assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /object-src 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.ok(r.text.includes('https://www.example-ak.in/') && !r.text.includes('%%SITE_URL%%'));
  assert.equal((await call('GET', '/api/health')).headers.get('cache-control'), 'no-store');
});
test('HSTS only over HTTPS (proxy header)', async () => {
  assert.equal((await call('GET', '/api/health')).headers.get('strict-transport-security'), null);
  assert.match((await call('GET', '/api/health', null, { 'x-forwarded-proto': 'https' })).headers.get('strict-transport-security'), /max-age=31536000/);
});
test('robots.txt and sitemap.xml use SITE_URL', async () => {
  const r = await call('GET', '/robots.txt'); assert.match(r.text, /Disallow: \/api\//); assert.match(r.text, /Sitemap: https:\/\/www\.example-ak\.in\/sitemap\.xml/);
  const s = await call('GET', '/sitemap.xml'); assert.match(s.text, /<loc>https:\/\/www\.example-ak\.in\/<\/loc>/);
});
test('CORS closed by default in production', async () => {
  const r = await call('GET', '/api/health', null, { origin: 'https://evil.example' });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});
test('oversized JSON rejected on normal routes', async () => {
  const r = await call('POST', '/api/enquiries', { name: 'x'.repeat(70000) }); assert.equal(r.status, 413);
});
test('enquiry rate limit + email validation', async () => {
  const e = (o) => ({ name: 'Rate Test', phone: '9876543210', service: 'Litho Printing', consent_operational: true, consent_promotional: false, consent_version: 'v1-2026-11', ...o });
  const bad = await call('POST', '/api/enquiries', e({ email: 'not-an-email' })); assert.equal(bad.status, 422); assert.match(bad.text, /email/);
  assert.equal((await call('POST', '/api/enquiries', e({ email: 'Priya@Example.com' }))).status, 201);
  assert.equal(db.prepare('SELECT email FROM customers WHERE phone=?').get('+919876543210').email, 'priya@example.com');
  assert.equal((await call('POST', '/api/enquiries', e({ email: null }))).status, 201);
  assert.equal(db.prepare('SELECT email FROM customers WHERE phone=?').get('+919876543210').email, 'priya@example.com', 'blank email never erases a stored one');
  assert.equal((await call('POST', '/api/enquiries', e({}))).status, 429);
});
test('SQL injection attempts are inert (prepared statements)', async () => {
  const r = await call('POST', '/api/orders/track', { order_id: "AK-2026-000001' OR '1'='1", phone: '9876543210' }); assert.equal(r.status, 422);
  token = JSON.parse((await call('POST', '/api/admin/login', { username: 'admin', password: 'prod-test-password-123' })).text).token;
  const s = await call('GET', "/api/admin/orders?q=" + encodeURIComponent("%' OR 1=1 --")); assert.equal(s.status, 200); assert.deepEqual(JSON.parse(s.text), []);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM orders').get().c, 2);
});
test('uploads: content must match declared image type', async () => {
  const fake = 'data:image/png;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64');
  const r = await call('POST', '/api/admin/gallery', { title: 'x', categories: ['event'], image_data_url: fake }); assert.equal(r.status, 422); assert.match(r.text, /not a valid PNG/);
  const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64');
  assert.equal((await call('POST', '/api/admin/gallery', { title: 'x', categories: ['event'], image_data_url: svg })).status, 422);
});
test('consent cannot be forged by the client', async () => {
  const before = db.prepare('SELECT COUNT(*) c FROM consent_records').get().c;
  assert.equal((await call('POST', '/api/admin/consents', { status: 'granted' })).status, 404, 'no write endpoint for consent records');
  assert.equal((await call('PATCH', '/api/admin/customers/1', { promo_consent: 1 })).status, 200);
  assert.equal(db.prepare('SELECT promo_consent FROM customers WHERE id=1').get().promo_consent, 0, 'admin cannot opt a customer in');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM consent_records').get().c, before);
});
test('password change revokes sessions; weak password refused', async () => {
  assert.equal((await call('POST', '/api/admin/password', { current: 'prod-test-password-123', next: 'short' })).status, 422);
  assert.equal((await call('POST', '/api/admin/password', { current: 'wrong', next: 'a-much-longer-password-99' })).status, 401);
  assert.equal((await call('POST', '/api/admin/password', { current: 'prod-test-password-123', next: 'a-much-longer-password-99' })).status, 200);
  assert.equal((await call('GET', '/api/admin/overview')).status, 401);
});
test('migrations are recorded and idempotent; backup works', () => {
  assert.deepEqual(db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((r) => r.id), [1, 2]);
  const { open, backup } = require('../src/db'); const db2 = open(path.join(tmp, 'ak.db'));
  assert.equal(db2.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c, 2);
  const f = backup(db, path.join(tmp, 'bk'), 'test'); assert.ok(fs.statSync(f).size > 0);
  const copy = open(f); assert.equal(copy.prepare('SELECT COUNT(*) c FROM orders').get().c, 2);
});
