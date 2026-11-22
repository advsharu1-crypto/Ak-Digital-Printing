'use strict';
const crypto = require('node:crypto');
const { redirect, send, siteUrl, isHttps, wrap } = require('../../lib/http');
const A = require('../../lib/auth');

module.exports = wrap(async (req, res) => {
  if (!A.methods().google) return redirect(res, '/admin?error=google_not_configured');
  // OAuth must start and finish on the same host so the state cookie is present.
  const base = new URL(siteUrl()); const host = String(req.headers.host || '').toLowerCase();
  if (host && host !== base.host && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return redirect(res, siteUrl() + '/api/auth/google');
  const state = crypto.randomBytes(24).toString('base64url'), nonce = crypto.randomBytes(24).toString('base64url');
  A.setCookie(res, isHttps(req) ? '__Host-ak_oauth' : 'ak_oauth', A.sign({ typ: 'oauth', state, nonce }, 600), 600, req);
  const origin = isHttps(req) ? siteUrl() : `http://${req.headers.host}`;
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: origin + '/api/auth/google/callback', response_type: 'code', scope: 'openid email profile', state, nonce, prompt: 'select_account' }).toString();
  return redirect(res, u.toString());
});
