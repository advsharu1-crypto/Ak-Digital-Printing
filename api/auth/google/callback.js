'use strict';
const { redirect, query, siteUrl, isHttps, wrap } = require('../../../lib/http');
const A = require('../../../lib/auth');
const { db, audit } = require('../../../lib/db');

const fail = (res, req, code) => { A.clearCookie(res, isHttps(req) ? '__Host-ak_oauth' : 'ak_oauth', req); return redirect(res, '/admin?error=' + code); };

module.exports = wrap(async (req, res) => {
  if (!A.methods().google) return redirect(res, '/admin?error=google_not_configured');
  const q = query(req);
  if (q.error) return fail(res, req, 'google_denied');
  const saved = A.verify(A.cookies(req)[isHttps(req) ? '__Host-ak_oauth' : 'ak_oauth']);
  if (!saved || saved.typ !== 'oauth' || !q.state || q.state !== saved.state || !q.code) return fail(res, req, 'google_state');

  const origin = isHttps(req) ? siteUrl() : `http://${req.headers.host}`;
  let tok;
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: q.code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: origin + '/api/auth/google/callback', grant_type: 'authorization_code' }) });
    if (!r.ok) return fail(res, req, 'google_exchange');
    tok = await r.json();
  } catch { return fail(res, req, 'google_exchange'); }

  // The id_token arrives directly from Google's token endpoint over TLS; we still validate every claim.
  let claims;
  try { claims = JSON.parse(Buffer.from(String(tok.id_token).split('.')[1], 'base64url').toString('utf8')); } catch { return fail(res, req, 'google_token'); }
  const now = Date.now() / 1000;
  const okClaims = ['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) && claims.aud === process.env.GOOGLE_CLIENT_ID && claims.exp > now && claims.nonce === saved.nonce && claims.email_verified === true && typeof claims.email === 'string';
  if (!okClaims) return fail(res, req, 'google_token');
  const email = claims.email.toLowerCase();
  if (!A.googleEmails().includes(email)) {
    const c = await db().catch(() => null); if (c) await audit(c, email, 'login_denied', null, 'google not on allowlist').catch(() => {});
    return fail(res, req, 'google_not_allowed');
  }
  A.clearCookie(res, isHttps(req) ? '__Host-ak_oauth' : 'ak_oauth', req);
  A.startSession(req, res, { sub: email, name: email, method: 'google' });
  const c = await db().catch(() => null); if (c) await audit(c, email, 'login', null, 'google').catch(() => {});
  return redirect(res, '/admin');
});
