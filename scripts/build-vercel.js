#!/usr/bin/env node
'use strict';
// Builds the front-end-only static site for Vercel into .vercel-site/ (no backend: Vercel has no persistent disk).
// - index.html = public/AK-Digital-Printing-Final.html + a Content-Security-Policy <meta> with SHA-256 hashes of its inline scripts
// - robots.txt / sitemap.xml use the production URL (VERCEL_PROJECT_PRODUCTION_URL or SITE_URL)
// - favicon and social images are copied from branding/
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const root = path.join(__dirname, '..'); const out = path.join(root, '.vercel-site');
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
const host = (process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : '')).replace(/\/+$/, '');
let html = fs.readFileSync(path.join(root, 'public', 'AK-Digital-Printing-Final.html'), 'utf8');
html = host ? html.split('%%SITE_URL%%').join(host) : html.replace(/<(?:link|meta)[^>]*%%SITE_URL%%[^>]*>\n?/g, '').split('%%SITE_URL%%').join('');
const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type=["']application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
const csp = ["default-src 'self'", `script-src 'self' ${hashes.join(' ')}`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https:",
  "font-src 'self' data:", 'connect-src \'self\' https:', "frame-src https://www.google.com https://maps.google.com", "object-src 'none'", "base-uri 'self'", "form-action 'self'"].join('; ');
html = html.replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);
fs.writeFileSync(path.join(out, 'index.html'), html);
const copy = (from, to) => { const s = path.join(root, 'branding', from); if (fs.existsSync(s)) { fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true }); fs.copyFileSync(s, path.join(out, to)); } };
copy('favicon/favicon.ico', 'favicon.ico'); copy('favicon/apple-touch-icon.png', 'apple-touch-icon.png');
copy('social/og-image-1200x630.jpg', 'og-image.jpg');
fs.writeFileSync(path.join(out, 'robots.txt'), `User-agent: *\nAllow: /\n${host ? `Sitemap: ${host}/sitemap.xml\n` : ''}`);
if (host) fs.writeFileSync(path.join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${host}/</loc></url></urlset>\n`);
console.log(`[build-vercel] ${(html.length / 1024).toFixed(0)} KB index.html, ${hashes.length} inline script hash(es), site url: ${host || '(none)'}`);
