'use strict';
const { send, wrap } = require('../../lib/http');
const A = require('../../lib/auth');
module.exports = wrap(async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
  if (req.headers['x-ak-admin'] !== '1') return send(res, 403, { error: 'Request blocked.' });
  A.clearCookie(res, A.sessionCookieName(req), req);
  return send(res, 200, { ok: true });
});
