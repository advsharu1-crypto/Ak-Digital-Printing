'use strict';
// Run: node --test test/   (uses an in-memory DB; provider HTTP calls are mocked in-test only)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');

process.env.ADMIN_USERNAME = 'admin'; process.env.ADMIN_PASSWORD = 'test-password-123';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-'));
const { createApp } = require('../src/server');
const { app, db } = createApp({ dbFile: ':memory:', uploadsDir: path.join(tmp, 'up'), publicDir: path.join(tmp, 'none') });
let base, server, token;

const call = async (method, url, body, auth = true) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(auth && token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const enquiry = (o = {}) => ({ name: 'Test Customer', phone: '9876543210', service: 'Flex Banner Printing', consent_operational: true, consent_promotional: false, consent_version: 'v1-2026-11', ...o });

test.before(async () => { server = app.listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

test('operational consent is enforced on the server', async () => {
  for (const bad of [{ consent_operational: false }, { consent_operational: 'true' }, { consent_operational: undefined }]) {
    const r = await call('POST', '/api/enquiries', enquiry(bad), false);
    assert.equal(r.status, 422); assert.equal(r.body.field, 'consent_operational');
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM orders').get().c, 0, 'no order may be created without consent');
  const v = await call('POST', '/api/enquiries', enquiry({ consent_version: 'old' }), false); assert.equal(v.status, 422);
  const p = await call('POST', '/api/enquiries', enquiry({ consent_promotional: undefined }), false); assert.equal(p.status, 422);
});

test('order IDs are sequential AK-YYYY-000001 and consent is recorded per order', async () => {
  const a = await call('POST', '/api/enquiries', enquiry({ consent_promotional: true }), false);
  const b = await call('POST', '/api/enquiries', enquiry({ phone: '+91 98765 00001', name: 'Second' }), false);
  assert.equal(a.status, 201); const y = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Kolkata', year: 'numeric' }).format(new Date());
  assert.equal(a.body.order_id, `AK-${y}-000001`); assert.equal(b.body.order_id, `AK-${y}-000002`);
  const rec = db.prepare('SELECT consent_type,status,consent_version FROM consent_records WHERE order_id=? ORDER BY id').all(a.body.order_id);
  assert.deepEqual(rec.map((r) => [r.consent_type, r.status]), [['operational', 'granted'], ['promotional', 'granted']]);
});

test('new enquiry without promo consent does not overwrite an earlier opt-in', async () => {
  await call('POST', '/api/enquiries', enquiry({ consent_promotional: false }), false); // same phone as first order
  assert.equal(db.prepare("SELECT promo_consent FROM customers WHERE phone='+919876543210'").get().promo_consent, 1);
});

test('admin auth required; login works', async () => {
  assert.equal((await call('GET', '/api/admin/orders', null, false)).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { username: 'admin', password: 'wrong' }, false)).status, 401);
  const r = await call('POST', '/api/admin/login', { username: 'admin', password: 'test-password-123' }, false);
  assert.equal(r.status, 200); token = r.body.token;
});

test('no provider configured: messages are NOT reported as sent; campaigns + review requests refuse', async () => {
  const orders = (await call('GET', '/api/admin/orders')).body;
  const tpl = (await call('POST', '/api/templates'.replace('/api', '/api/admin'), { name: 'Status', category: 'service', channel: 'sms', body: 'Hi {{name}}, order {{order_id}} is {{status}}', trigger_status: 'Quotation Prepared', dlt_template_id: '1107000000000000001', sender_id: 'AKDGPR', provider_template_id: 'flow1', variables: 'name,order_id,status' })).body;
  const u = await call('PATCH', `/api/admin/orders/${orders[0].id}`, { status: 'Quotation Prepared', quotation_amount: 1500 });
  assert.equal(u.body.notification.status, 'not_sent');
  const promo = (await call('POST', '/api/admin/templates', { name: 'Diwali', category: 'promotional', channel: 'sms', body: 'Offer {{offer}}', dlt_template_id: '1', sender_id: 'AKDGPR', provider_template_id: 'f2' })).body;
  const c = (await call('POST', '/api/admin/campaigns', { name: 'Diwali', template_id: promo.id, audience: {} })).body;
  const otp = await call('POST', `/api/admin/campaigns/${c.id}/request-otp`); assert.equal(otp.status, 503);
  const rr = await call('POST', '/api/admin/review-requests', { customer_ids: [1], template_id: tpl.id });
  assert.equal(rr.status, 422); // review link not configured yet
  await call('PUT', '/api/admin/settings', { google_review_url: 'https://g.page/r/example/review' });
  assert.equal((await call('POST', '/api/admin/review-requests', { customer_ids: [1], template_id: tpl.id })).status, 503);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM communications WHERE status IN ('sent','delivered')").get().c, 0);
});

test('order workflow: history, payments, validation', async () => {
  const id = (await call('GET', '/api/admin/orders')).body[0].id;
  assert.equal((await call('PATCH', `/api/admin/orders/${id}`, { status: 'Out for Delivery' })).status, 422);
  assert.equal((await call('POST', `/api/admin/orders/${id}/payments`, { kind: 'advance', amount: 500, method: 'UPI' })).status, 422, 'UPI needs reference');
  assert.equal((await call('POST', `/api/admin/orders/${id}/payments`, { kind: 'advance', amount: 500, method: 'UPI', reference: 'UTR123', verified: true })).status, 201);
  const d = (await call('GET', `/api/admin/orders/${id}`)).body;
  assert.ok(d.history.length >= 1); assert.equal(d.payments[0].verified, 1);
  const s = (await call('GET', '/api/admin/orders?q=Second')).body; assert.equal(s.length, 1);
});

test('settings validation rejects invented / invalid ratings', async () => {
  assert.equal((await call('PUT', '/api/admin/settings', { google_rating: '7' })).status, 422);
  assert.equal((await call('PUT', '/api/admin/settings', { social_facebook: 'javascript:alert(1)' })).status, 422);
});

test('reminders: consent respected, duplicates prevented, IST date used (mocked provider)', async () => {
  process.env.MSG91_AUTHKEY = 'test-key';
  const realFetch = global.fetch; let sends = 0;
  global.fetch = async (url, opts) => { if (String(url).includes('msg91')) { sends++; return new Response(JSON.stringify({ type: 'success', message: 'req-' + sends }), { status: 200 }); } return realFetch(url, opts); };
  try {
    const tpl = (await call('POST', '/api/admin/templates', { name: 'Reminder', category: 'promotional', channel: 'sms', body: 'Hi {{name}}, {{event}} in {{days}} days', dlt_template_id: '9', sender_id: 'AKDGPR', provider_template_id: 'f9' })).body;
    const types = (await call('GET', '/api/admin/event-types')).body; const bday = types.find((t) => t.name === 'Birthday');
    await call('PUT', `/api/admin/event-types/${bday.id}`, { template_id: tpl.id, intervals: '7' });
    const { todayIST } = require('../src/server');
    const d = new Date(todayIST() + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 7); const target = `1990-${d.toISOString().slice(5, 10)}`;
    const cs = (await call('GET', '/api/admin/customers')).body;
    const opted = cs.find((c) => c.promo_consent === 1), notOpted = cs.find((c) => c.promo_consent === 0);
    await call('POST', `/api/admin/customers/${opted.id}/events`, { event_type_id: bday.id, event_date: target });
    await call('POST', `/api/admin/customers/${notOpted.id}/events`, { event_type_id: bday.id, event_date: target });
    const r1 = (await call('POST', '/api/admin/reminders/run')).body;
    assert.equal(r1.sent, 1); assert.equal(r1.skipped, 1);
    const r2 = (await call('POST', '/api/admin/reminders/run')).body;
    assert.equal(r2.sent, 0, 'duplicate prevented'); assert.equal(sends, 1);
    // withdrawal is immediate
    await call('PATCH', `/api/admin/customers/${opted.id}`, { withdraw_promotional: true });
    const p = (await call('POST', '/api/admin/campaigns/preview', { audience: {} })).body; assert.equal(p.eligible, 0);
    // DLR webhook moves sent -> delivered only with secret
    process.env.WEBHOOK_SECRET = 's3';
    assert.equal((await call('POST', '/api/webhooks/sms-dlr', { requestId: 'req-1', status: 'delivered' }, false)).status, 403);
    await call('POST', '/api/webhooks/sms-dlr?secret=s3', { requestId: 'req-1', status: 'delivered' }, false);
    assert.equal(db.prepare("SELECT status FROM communications WHERE provider_message_id='req-1'").get().status, 'delivered');
  } finally { global.fetch = realFetch; delete process.env.MSG91_AUTHKEY; }
});

test('campaign OTP: expiry/attempt limits (mocked provider)', async () => {
  process.env.MSG91_AUTHKEY = 'k'; process.env.ADMIN_OTP_MOBILE = '9585232399'; process.env.OTP_TEMPLATE_ID = 'otpflow'; process.env.OTP_DLT_TEMPLATE_ID = '1107000000000000099'; process.env.OTP_SENDER_ID = 'AKDGPR';
  const realFetch = global.fetch; let lastOtp = null;
  global.fetch = async (url, opts) => { if (String(url).includes('msg91')) { const b = JSON.parse(opts.body); if (b.recipients[0].otp) lastOtp = b.recipients[0].otp; return new Response(JSON.stringify({ type: 'success', message: 'x' }), { status: 200 }); } return realFetch(url, opts); };
  try {
    const promo = (await call('GET', '/api/admin/templates')).body.find((t) => t.name === 'Diwali');
    const c = (await call('POST', '/api/admin/campaigns', { name: 'T2', template_id: promo.id, audience: {} })).body;
    assert.equal((await call('POST', `/api/admin/campaigns/${c.id}/execute`, { otp: '000000' })).status, 422);
    assert.equal((await call('POST', `/api/admin/campaigns/${c.id}/request-otp`)).status, 200); assert.match(lastOtp, /^\d{6}$/);
    const wrong = lastOtp === '111111' ? '222222' : '111111';
    for (let i = 0; i < 3; i++) assert.equal((await call('POST', `/api/admin/campaigns/${c.id}/execute`, { otp: wrong })).status, 422);
    const r = await call('POST', `/api/admin/campaigns/${c.id}/execute`, { otp: lastOtp });
    assert.equal(r.status, 422); assert.match(r.body.error, /Too many/);
  } finally { global.fetch = realFetch; delete process.env.MSG91_AUTHKEY; }
});

test('customer order tracking requires matching phone; gallery CRUD is admin-only', async () => {
  const id = db.prepare('SELECT o.id FROM orders o JOIN customers c ON c.id=o.customer_id WHERE c.phone=?').get('+919876543210').id;
  assert.equal((await call('POST', '/api/orders/track', { order_id: id, phone: '9000000000' }, false)).status, 404);
  const ok = await call('POST', '/api/orders/track', { order_id: id, phone: '98765 43210' }, false);
  assert.equal(ok.status, 200); assert.equal(ok.body.order_id, id); assert.ok(ok.body.history.length >= 1);
  assert.equal(ok.body.phone, undefined, 'no personal data echoed');
  assert.equal((await call('POST', '/api/admin/gallery', { title: 'x', categories: ['event'] }, false)).status, 401);
  const png = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex').toString('base64');
  assert.equal((await call('POST', '/api/admin/gallery', { title: 'Banner', categories: ['nope'], image_data_url: png })).status, 422);
  const g = await call('POST', '/api/admin/gallery', { title: 'Temple banner', categories: ['event', 'community'], image_data_url: png });
  assert.equal(g.status, 201);
  const site = (await call('GET', '/api/public/site', null, false)).body;
  assert.equal(site.gallery[0].title, 'Temple banner'); assert.equal(site.gallery[0].categories, 'event community');
  await call('PUT', `/api/admin/gallery/${g.body.id}`, { enabled: false });
  assert.equal((await call('GET', '/api/public/site', null, false)).body.gallery.length, 0);
});
