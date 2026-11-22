'use strict';
// Local development/test server: serves the built site (.vercel-site) and runs the /api serverless handlers.
// Usage: AK_TEST_PGLITE=1 SESSION_SECRET=... ADMIN_PASSWORD=... node scripts/dev-server.js
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '..'), site = path.join(root, '.vercel-site');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain', '.xml': 'application/xml' };

function handlerFor(pathname) {
  const rel = pathname.replace(/^\/api\//, '').replace(/\/+$/, '');
  if (!/^[a-z0-9/_-]+$/i.test(rel)) return null;
  const f = path.join(root, 'api', rel + '.js');
  return f.startsWith(path.join(root, 'api') + path.sep) && fs.existsSync(f) ? require(f) : null;
}
function createServer() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://local');
    if (u.pathname.startsWith('/api/')) {
      const h = handlerFor(u.pathname);
      if (!h) { res.statusCode = 404; return res.end('{"error":"Not found"}'); }
      return h(req, res);
    }
    let p = u.pathname === '/admin' ? '/admin/index.html' : u.pathname === '/' ? '/index.html' : u.pathname;
    const f = path.normalize(path.join(site, p));
    if (!f.startsWith(site + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream');
    if (p.startsWith('/admin')) res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(f).pipe(res);
  });
}
module.exports = { createServer };
if (require.main === module) { const port = Number(process.env.PORT) || 3000; createServer().listen(port, () => console.log('dev server on http://localhost:' + port)); }
