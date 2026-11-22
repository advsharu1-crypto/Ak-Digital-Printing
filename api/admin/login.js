'use strict';
const { send, readJson, wrap } = require('../../lib/http');
const A = require('../../lib/auth');
const { db, audit } = require('../../lib/db');

module.exports = wrap(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
  if (req.headers['x-ak-admin'] !== '1') return send(res, 403, { error: 'Request blocked.' });
  if (!A.methods().password) return send(res, 503, { error: 'Password sign-in is not configured.' });
  const b = await readJson(req, 4096);
  const user = String(b.username || '').slice(0, 80), pass = String(b.password || '').slice(0, 200);
  const keys = A.loginKeys(req, user);
  if (await A.lockStatus(keys)) return send(res, 429, { error: `Too many failed attempts. Try again in ${A.LOCK_MINUTES} minutes.` });
  const ok = A.checkPassword(user, pass);
  await A.recordLogin(keys, ok);
  if (!ok) { await A.sleep(600); return send(res, 401, { error: 'Incorrect username or password.' }); }
  A.startSession(req, res, { sub: A.adminUsername(), name: A.adminUsername(), method: 'password' });
  const c = await db().catch(() => null); if (c) await audit(c, A.adminUsername(), 'login', null, 'password').catch(() => {});
  return send(res, 200, { ok: true });
});
