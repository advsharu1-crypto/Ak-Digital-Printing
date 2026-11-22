'use strict';
const { send, wrap } = require('../../lib/http');
const A = require('../../lib/auth');
const { dbConfigured } = require('../../lib/db');
module.exports = wrap(async (req, res) => {
  const s = A.getSession(req); const m = A.methods();
  return send(res, 200, { authenticated: !!s, user: s ? { name: s.name, method: s.method } : null, methods: { google: m.google, password: m.password }, db: dbConfigured() });
});
