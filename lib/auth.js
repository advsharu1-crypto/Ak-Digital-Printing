'use strict';
const crypto = require('node:crypto');
const { send, ipHash, isHttps } = require('./http');
const { db, countEvents, addEvent } = require('./db');

const SESSION_TTL = 12 * 60 * 60; // 12 hours
const MAX_FAILS = 5, LOCK_MINUTES = 15;

const secret = () => { const s = process.env.SESSION_SECRET || ''; return s.length >= 32 ? s : null; };
const sessionVersion = () => String(process.env.ADMIN_SESSION_VERSION || '1');

function sign(payload, ttl) {
  const s = secret(); if (!s) throw Object.assign(new Error('SESSION_SECRET is not set'), { status: 503 });
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttl })).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', s).update(body).digest('base64url');
}
function verify(token) {
  const s = secret(); if (!s || !token || typeof token !== 'string') return null;
  const [body, mac] = token.split('.'); if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', s).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(want); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  return p && p.exp > Date.now() / 1000 ? p : null;
}
const safeEq = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };

function cookies(req) {
  const out = {}; for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } return out;
}
function addCookie(res, line) { const prev = res.getHeader('Set-Cookie'); res.setHeader('Set-Cookie', prev ? [].concat(prev, line) : [line]); }
const sessionCookieName = (req) => (isHttps(req) ? '__Host-ak_admin' : 'ak_admin');
function setCookie(res, name, value, maxAge, req) {
  addCookie(res, `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`);
}
const clearCookie = (res, name, req) => setCookie(res, name, '', 0, req);

/** Which sign-in methods are configured on the server (no secrets exposed). */
function methods() {
  const pw = !!(process.env.ADMIN_PASSWORD_HASH || (process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length >= 12));
  const google = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && googleEmails().length);
  return { password: pw && !!secret(), google: google && !!secret(), session: !!secret() };
}
const googleEmails = () => String(process.env.ADMIN_GOOGLE_EMAILS || '').split(/[,\s;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
const adminUsername = () => process.env.ADMIN_USERNAME || 'akadmin';

function checkPassword(user, pass) {
  const okUser = safeEq(String(user || '').toLowerCase(), adminUsername().toLowerCase());
  let okPass = false;
  const h = process.env.ADMIN_PASSWORD_HASH;
  if (h && h.includes(':')) { const [salt, hash] = h.split(':'); try { okPass = safeEq(crypto.scryptSync(String(pass || ''), salt, 64).toString('hex'), hash); } catch { okPass = false; } }
  else if (process.env.ADMIN_PASSWORD) okPass = safeEq(pass || '', process.env.ADMIN_PASSWORD);
  return okUser && okPass;
}

/** Session for this request, or null. */
function getSession(req) {
  const p = verify(cookies(req)[sessionCookieName(req)]);
  return p && p.v === sessionVersion() && p.typ === 'admin' ? p : null;
}
function startSession(req, res, who) {
  setCookie(res, sessionCookieName(req), sign({ typ: 'admin', v: sessionVersion(), sub: who.sub, name: who.name || who.sub, method: who.method }, SESSION_TTL), SESSION_TTL, req);
}
/** Guard for admin endpoints. State-changing calls must carry the custom header (cross-site forms/fetches cannot). */
function requireAdmin(req, res) {
  const s = getSession(req);
  if (!s) { send(res, 401, { error: 'Please sign in.' }); return null; }
  if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-ak-admin'] !== '1') { send(res, 403, { error: 'Request blocked.' }); return null; }
  return s;
}

// ---- brute-force protection (DB-backed; per-instance memory fallback) ----
const mem = new Map();
async function lockStatus(keys) {
  const c = await db().catch(() => null);
  for (const k of keys) {
    const n = c ? await countEvents(c, k, 'login', LOCK_MINUTES, true) : (mem.get(k) || []).filter((t) => t > Date.now() - LOCK_MINUTES * 60000).length;
    if (n >= MAX_FAILS) return true;
  }
  return false;
}
async function recordLogin(keys, ok) {
  const c = await db().catch(() => null);
  for (const k of keys) { if (c) await addEvent(c, k, 'login', ok).catch(() => {}); else if (!ok) mem.set(k, [...(mem.get(k) || []), Date.now()].slice(-20)); }
}
const loginKeys = (req, user) => ['ip:' + ipHash(req), 'user:' + String(user || '').toLowerCase().slice(0, 60)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { sign, verify, cookies, setCookie, clearCookie, sessionCookieName, methods, googleEmails, adminUsername, checkPassword, getSession, startSession, requireAdmin, lockStatus, recordLogin, loginKeys, sleep, secret, LOCK_MINUTES };
