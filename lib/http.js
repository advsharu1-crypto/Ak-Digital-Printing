'use strict';
const crypto = require('node:crypto');

const siteUrl = () => (process.env.SITE_URL || 'https://www.akdigitalprinters.com').replace(/\/+$/, '');

/** Send a response. Objects become JSON. Everything from these functions is uncacheable and not indexable. */
function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (typeof body === 'string' || Buffer.isBuffer(body)) return res.end(body);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.end(JSON.stringify(body));
}
const redirect = (res, to, status = 302) => send(res, status, '', { Location: to });

/** JSON body (Vercel pre-parses; fall back to reading the stream). Enforces a size limit. */
async function readJson(req, limit = 32 * 1024) {
  let b = req.body;
  if (b === undefined || b === null) {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('Body too large'), { status: 413 }); chunks.push(c); }
    b = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') { if (b.length > limit) throw Object.assign(new Error('Body too large'), { status: 413 }); if (!b.trim()) return {}; try { b = JSON.parse(b); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); } }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw Object.assign(new Error('Invalid body'), { status: 400 });
  if (JSON.stringify(b).length > limit) throw Object.assign(new Error('Body too large'), { status: 413 });
  return b;
}

const query = (req) => Object.fromEntries(new URL(req.url, 'http://local').searchParams);

function clientIp(req) {
  const xr = req.headers['x-real-ip']; if (xr) return String(xr).trim();
  const xf = req.headers['x-forwarded-for']; if (xf) return String(xf).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
/** Salted hash so raw IPs are never stored. */
const ipHash = (req) => crypto.createHash('sha256').update((process.env.SESSION_SECRET || 'ak') + '|' + clientIp(req)).digest('hex').slice(0, 24);

const isHttps = (req) => process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https';

/** Wrap a handler so that unexpected errors return a clean JSON 500 (never a stack trace). */
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    const status = e && e.status >= 400 && e.status < 500 ? e.status : 500;
    if (status === 500) console.error('[ak-api]', req.method, (req.url || '').split('?')[0], e && e.message);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong. Please try again.' : e.message });
  }
};
module.exports = { send, redirect, readJson, query, clientIp, ipHash, isHttps, siteUrl, wrap };
