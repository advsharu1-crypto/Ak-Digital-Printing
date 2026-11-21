#!/usr/bin/env node
'use strict';
// Builds the front-end-only static site for Vercel into .vercel-site/ (no backend: Vercel has no persistent disk).
// - index.html = public/AK-Digital-Printing-Final.html + a Content-Security-Policy <meta> with SHA-256 hashes of its inline scripts
// - robots.txt / sitemap.xml use the production URL (VERCEL_PROJECT_PRODUCTION_URL or SITE_URL)
// - favicon and social images are copied from branding/
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const root = path.join(__dirname, '..'); const out = path.join(root, '.vercel-site');
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
// Canonical public address (override with SITE_URL). Social previews (WhatsApp, Facebook, X) need ABSOLUTE image URLs.
const host = (process.env.SITE_URL || 'https://www.akdigitalprinters.com').replace(/\/+$/, '');
let html = fs.readFileSync(path.join(root, 'public', 'AK-Digital-Printing-Final.html'), 'utf8');
html = host ? html.split('%%SITE_URL%%').join(host) : html.replace(/<(?:link|meta)[^>]*%%SITE_URL%%[^>]*>\n?/g, '').split('%%SITE_URL%%').join('');

// ---- Quotation form without a backend: email the enquiry through Web3Forms (public access key) ----
// Only used when the AK backend is NOT reachable (as on Vercel). With a backend the site still creates a real Order ID.
const W3F_KEY = process.env.WEB3FORMS_KEY || '2232f548-69ed-4141-bb08-0e1403a3c435';
const sub = (from, to) => { if (!html.includes(from)) throw new Error('build-vercel: expected code not found: ' + from.slice(0, 60)); html = html.replace(from, () => to); };
sub('function updateFormMode(ok){', `const W3F=${JSON.stringify(W3F_KEY)};
async function sendWeb3(d){
  const r=await fetch('https://api.web3forms.com/submit',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({
    access_key:W3F,subject:'New enquiry: '+d.service+' ('+d.name+')',from_name:'AK Digital Printing website',botcheck:'',
    name:d.name,phone:'+91 '+d.phone,...(d.email?{email:d.email}:{}),service:d.service,size:d.size||'-',quantity:d.quantity||'-',needed_by:d.needed_by||'-',message:d.details||'-',
    operational_consent:d.consent_operational?'Yes':'No',promotional_consent:d.consent_promotional?'Yes':'No',consent_version:d.consent_version,
    note:'Sent from the website without a database: no Order ID has been issued. Consent choices above are as ticked by the customer.'})});
  const j=await r.json().catch(()=>({}));if(!r.ok||!j.success)throw new Error(j.message||'The enquiry service did not accept the request');
}
function updateFormMode(ok){`);
sub("'Online registration is unavailable here, so your enquiry will open in WhatsApp for you to review and send. You can withdraw promotional consent at any time — '",
    "'Your enquiry is sent to our team by email and we will contact you with your quotation. No Order ID is issued online yet. You can withdraw promotional consent at any time — '");
sub("if(!ok){showResult('offline',d);return}", "if(!ok){try{await sendWeb3(d);showResult('emailed',d);form.reset()}catch(err){showResult('error',d,null,'We could not send your enquiry just now.')}return}");
sub("else if(kind==='offline')h=", "else if(kind==='emailed')h=`<div class=\"result-icon ok\">✓</div><h3 id=\"resultTitle\">Enquiry sent</h3><p class=\"muted-p\">Thank you, ${esc(d.name)}. Our team will contact you on +91 ${esc(d.phone)} with your quotation. No Order ID has been issued online yet; we will share one when your order is registered. ${d.consent_promotional?'You opted in to offers and reminders: you can stop them any time.':'You will not receive promotional messages.'}</p><a class=\"btn btn-gold\" style=\"width:100%\" target=\"_blank\" rel=\"noopener\" href=\"${wa}\">Also send reference design on WhatsApp ↗</a>`;\n  else if(kind==='offline')h=");

const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [, 'AK Digital Printing'])[1];
const social = ['<meta name="google-site-verification" content="QPN6BRJWkKJXN0_p01m_lWYSxLivh8r0JJLJMKnWJWA">', `<link rel="canonical" href="${host}/">`, `<meta property="og:url" content="${host}/">`,
  `<meta property="og:image" content="${host}/og-image.jpg">`, `<meta property="og:image:secure_url" content="${host}/og-image.jpg">`,
  '<meta property="og:image:type" content="image/jpeg">', '<meta property="og:image:width" content="1200">', '<meta property="og:image:height" content="630">',
  '<meta property="og:image:alt" content="AK Digital Printing, Suranam: flex banners, photo printing, name boards, litho printing and xerox">',
  `<meta name="twitter:image" content="${host}/og-image.jpg">`].join('\n');
html = html.replace(/<meta name="google-site-verification"[^>]*>\n?/g, '');
html = html.replace(/<link rel="canonical"[^>]*>\n?|<meta property="og:(?:url|image[^"]*)"[^>]*>\n?|<meta name="twitter:image"[^>]*>\n?/g, '');
// Insert near the TOP of <head>: crawlers such as WhatsApp read only the first few hundred KB and this page has large inline data after the meta tags.
html = html.replace('<title>', social + '\n<title>');
const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*type=["']application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
const csp = ["default-src 'self'", `script-src 'self' ${hashes.join(' ')}`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https:",
  "font-src 'self' data:", 'connect-src \'self\' https:', "frame-src https://www.google.com https://maps.google.com", "object-src 'none'", "base-uri 'self'", "form-action 'self'"].join('; ');
html = html.replace('<head>', `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);
fs.writeFileSync(path.join(out, 'index.html'), html);
const copy = (from, to) => { const s = path.join(root, 'branding', from); if (fs.existsSync(s)) { fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true }); fs.copyFileSync(s, path.join(out, to)); } };
copy('favicon/favicon.ico', 'favicon.ico'); copy('favicon/apple-touch-icon.png', 'apple-touch-icon.png');
copy('social/og-image-1200x630.jpg', 'og-image.jpg');
// Search Console verification files (verification/*.html are served from the site root)
const vdir = path.join(root, 'verification'); if (fs.existsSync(vdir)) for (const f of fs.readdirSync(vdir)) fs.copyFileSync(path.join(vdir, f), path.join(out, f));
fs.writeFileSync(path.join(out, 'robots.txt'), `User-agent: *\nAllow: /\n${host ? `Sitemap: ${host}/sitemap.xml\n` : ''}`);
if (host) fs.writeFileSync(path.join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${host}/</loc></url></urlset>\n`);
console.log(`[build-vercel] ${(html.length / 1024).toFixed(0)} KB index.html, ${hashes.length} inline script hash(es), site url: ${host || '(none)'}`);
