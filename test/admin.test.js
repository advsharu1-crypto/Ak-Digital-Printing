'use strict';
process.env.AK_TEST_PGLITE = '1';
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.ADMIN_PASSWORD = 'correct-horse-battery';
process.env.ADMIN_USERNAME = 'akadmin';
process.env.ADMIN_GOOGLE_EMAILS = 'Owner@Gmail.com, staff@gmail.com';
process.env.GOOGLE_CLIENT_ID = 'cid.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'gsecret';
process.env.SITE_URL = 'http://localhost';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../scripts/dev-server');

let srv, base; const realFetch = globalThis.fetch; let googleReply = null;
before(async () => {
  srv = createServer(); await new Promise((r) => srv.listen(0, r)); base = 'http://localhost:' + srv.address().port;
  globalThis.fetch = (url, opt) => String(url).startsWith('https://oauth2.googleapis.com/') ? Promise.resolve(googleReply()) : realFetch(url, opt);
});
after(() => { globalThis.fetch = realFetch; srv.close(); });

const jar = (res) => (res.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
const json = (method, p, body, cookie, extra = {}) => realFetch(base + p, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
const A = { 'x-ak-admin': '1' };
const good = { name: 'Ravi Kumar', phone: '9585232399', email: 'ravi@example.com', service: 'Flex & Banners', size: '10x4 ft', quantity: 2, details: '=HYPERLINK("http://evil")', consent_operational: true, consent_promotional: false };
async function login() { const r = await json('POST', '/api/admin/login', { username: 'akadmin', password: 'correct-horse-battery' }, null, A); assert.equal(r.status, 200); return jar(r); }

test('public enquiry: validation, honeypot, success', async () => {
  let r = await json('POST', '/api/enquiry', { ...good, name: 'x' }); assert.equal(r.status, 400);
  r = await json('POST', '/api/enquiry', { ...good, phone: '12345' }); assert.equal(r.status, 400);
  r = await json('POST', '/api/enquiry', { ...good, consent_operational: false }); assert.equal(r.status, 400);
  r = await json('POST', '/api/enquiry', { ...good, website: 'http://spam' }); assert.equal(r.status, 200); // silently dropped
  r = await json('POST', '/api/enquiry', good, null, { origin: 'https://evil.example' }); assert.equal(r.status, 403);
  r = await json('POST', '/api/enquiry', good, null, { origin: 'http://localhost' }); assert.equal(r.status, 201);
  assert.ok((await r.json()).id > 0);
  assert.equal((await json('GET', '/api/enquiry')).status, 405);
});

test('admin API requires a session', async () => {
  for (const p of ['/api/admin/enquiries', '/api/admin/export']) assert.equal((await json('GET', p)).status, 401);
  const me = await (await json('GET', '/api/admin/me')).json(); assert.equal(me.authenticated, false); assert.deepEqual(me.methods, { google: true, password: true });
  assert.equal((await json('POST', '/api/admin/login', { username: 'akadmin', password: 'correct-horse-battery' })).status, 403); // missing custom header
});

test('password login, list, filter, patch, csv, delete, logout', async () => {
  const c = await login();
  const me = await (await json('GET', '/api/admin/me', null, c)).json(); assert.equal(me.authenticated, true); assert.equal(me.user.method, 'password');
  let d = await (await json('GET', '/api/admin/enquiries', null, c)).json();
  assert.equal(d.total, 1); assert.equal(d.stats.byStatus.New, 1); const id = d.rows[0].id;
  assert.equal((await (await json('GET', '/api/admin/enquiries?q=ravi', null, c)).json()).total, 1);
  assert.equal((await (await json('GET', '/api/admin/enquiries?q=nobody%25', null, c)).json()).total, 0);
  assert.equal((await (await json('GET', '/api/admin/enquiries?status=Closed', null, c)).json()).total, 0);
  // state-changing calls need the custom header and valid values
  assert.equal((await json('PATCH', '/api/admin/enquiries?id=' + id, { status: 'Quoted' }, c)).status, 403);
  assert.equal((await json('PATCH', '/api/admin/enquiries?id=' + id, { status: 'Bogus' }, c, A)).status, 400);
  let r = await json('PATCH', '/api/admin/enquiries?id=' + id, { status: 'Quoted', note: 'Sent quote ₹4,200' }, c, A); assert.equal(r.status, 200);
  d = await (await json('GET', '/api/admin/enquiries?status=Quoted', null, c)).json(); assert.equal(d.rows[0].note, 'Sent quote ₹4,200'); assert.equal(d.rows[0].handled_by, 'akadmin');
  const buf = Buffer.from(await (await json('GET', '/api/admin/export', null, c)).arrayBuffer()); const csv = buf.toString('utf8');
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for Excel'); assert.ok(csv.includes('"ID"')); assert.ok(csv.includes('"\'=HYPERLINK'), 'formula injection must be neutralised');
  assert.equal((await json('PATCH', '/api/admin/enquiries?id=99999', { status: 'Closed' }, c, A)).status, 404);
  assert.equal((await json('DELETE', '/api/admin/enquiries?id=' + id, null, c, A)).status, 200);
  assert.equal((await (await json('GET', '/api/admin/enquiries', null, c)).json()).total, 0);
  r = await json('POST', '/api/admin/logout', null, c, A); assert.equal(r.status, 200);
  assert.ok(/Max-Age=0/.test(r.headers.get('set-cookie')));
});

test('tampered or expired sessions are rejected', async () => {
  const c = await login(); const [name, val] = c.split('=');
  assert.equal((await json('GET', '/api/admin/enquiries', null, name + '=' + val.slice(0, -2) + 'xx')).status, 401);
  const A2 = require('../lib/auth'); const old = A2.sign({ typ: 'admin', v: '1', sub: 'x', name: 'x', method: 'password' }, -10);
  assert.equal((await json('GET', '/api/admin/enquiries', null, name + '=' + encodeURIComponent(old))).status, 401);
  process.env.ADMIN_SESSION_VERSION = '2'; assert.equal((await json('GET', '/api/admin/enquiries', null, c)).status, 401); delete process.env.ADMIN_SESSION_VERSION;
});

test('google sign-in: allowlist, nonce/state and claim checks', async () => {
  const start = await json('GET', '/api/auth/google'); assert.equal(start.status, 302);
  const loc = new URL(start.headers.get('location')); assert.equal(loc.host, 'accounts.google.com'); assert.equal(loc.searchParams.get('client_id'), process.env.GOOGLE_CLIENT_ID);
  const state = loc.searchParams.get('state'), nonce = loc.searchParams.get('nonce'), ck = jar(start);
  const idt = (o) => 'h.' + Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600, nonce, email_verified: true, email: 'owner@gmail.com', ...o })).toString('base64url') + '.s';
  const reply = (o) => { googleReply = () => new Response(JSON.stringify({ id_token: idt(o) }), { status: 200 }); };
  const cb = (st = state, cookie = ck) => json('GET', '/api/auth/google/callback?code=abc&state=' + st, null, cookie);
  reply({}); let r = await cb('wrong'); assert.ok(r.headers.get('location').includes('error=google_state'));
  r = await cb(state, ''); assert.ok(r.headers.get('location').includes('error=google_state'));
  reply({ email: 'stranger@gmail.com' }); r = await cb(); assert.ok(r.headers.get('location').includes('google_not_allowed'));
  reply({ email_verified: false }); r = await cb(); assert.ok(r.headers.get('location').includes('google_token'));
  reply({ nonce: 'other' }); r = await cb(); assert.ok(r.headers.get('location').includes('google_token'));
  reply({ aud: 'someone-else' }); r = await cb(); assert.ok(r.headers.get('location').includes('google_token'));
  reply({ exp: 1 }); r = await cb(); assert.ok(r.headers.get('location').includes('google_token'));
  reply({}); r = await cb(); assert.equal(r.headers.get('location'), '/admin');
  const me = await (await json('GET', '/api/admin/me', null, jar(r))).json(); assert.equal(me.authenticated, true); assert.equal(me.user.method, 'google'); assert.equal(me.user.name, 'owner@gmail.com');
  googleReply = () => new Response('{}', { status: 400 }); r = await cb(); assert.ok(r.headers.get('location').includes('google_exchange'));
});

test('brute-force lockout after 5 failed passwords', async () => {
  const bad = () => json('POST', '/api/admin/login', { username: 'locktest', password: 'nope-nope-nope' }, null, A);
  for (let i = 0; i < 5; i++) assert.equal((await bad()).status, 401);
  assert.equal((await bad()).status, 429);
});

test('static: admin page, security headers inputs, noindex', async () => {
  const r = await realFetch(base + '/admin'); assert.equal(r.status, 200); const t = await r.text();
  assert.ok(t.includes('Staff sign-in')); assert.ok(!/<script(?![^>]*src)/i.test(t), 'no inline scripts'); assert.ok(!/\sstyle=/i.test(t), 'no inline styles');
  assert.ok((await (await realFetch(base + '/robots.txt')).text()).includes('Disallow: /admin'));
});
