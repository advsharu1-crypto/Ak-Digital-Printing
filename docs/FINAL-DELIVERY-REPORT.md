# AK Digital Printing — Final production delivery report

Date: 21 Nov 2026 (IST) · Source: the AK Digital Printing project from the previous delivery (the uploaded HTML matched that build exactly).

## Website

| Item | Status |
|---|---|
| Live website URL | **Not live yet.** Deployment needs your hosting account and domain (see *Access required* at the end). No public URL exists, so none is claimed. |
| Deployment platform | Ready for: **VPS + Docker + Caddy (recommended)**, Render (Starter + disk) or Railway (with volume). Configs: `Dockerfile`, `deploy/`. Vercel/Netlify are unsuitable (no persistent disk for the database). |
| Domain status | Not configured — needs a domain and DNS access. |
| HTTPS status | Configured but not live: Caddy obtains a Let's Encrypt certificate automatically once DNS points to the server. HSTS, `upgrade-insecure-requests` and the secure-only headers switch on automatically over HTTPS (tested with a simulated HTTPS proxy header). |
| Production build | ✅ `dist/`: 108 KB HTML (27 KB compressed), 42 content-hashed assets with one-year immutable caching |
| Standalone file | ✅ `public/AK-Digital-Printing-Final.html` (1.6 MB, opens offline) |

## Testing

| Suite | Total | Passed | Failed |
|---|---|---|---|
| Backend unit + API (`backend/test/api.test.js`) | 11 | 11 | 0 |
| Backend production security (`backend/test/security.test.js`) | 10 | 10 | 0 |
| Browser — standalone file, desktop / tablet / mobile (`tests/e2e_standalone.py`) | 63 | 63 | 0 |
| Browser — production build + admin + order workflow (`tests/e2e_backend.py`) | 39 | 39 | 0 |
| Browser — responsive at 320 / 375 / 425 / 768 / 1024 / 1366 / 1920, English + Tamil (`tests/e2e_responsive.py`) | 97 | 97 | 0 |
| **Total automated** | **220** | **220** | **0** |
| Clean-bundle production startup (`npm ci --omit=dev`, `NODE_ENV=production`) | — | ✅ health, site, assets, Order ID, daily backup, scheduler | — |
| Upgrade test: database from the previous release opened by the new code | — | ✅ 3 orders, 6 consent records and the opt-in preserved; pre-migration backup written | — |
| `npm audit` (production dependencies) | — | 0 vulnerabilities | — |

**Browser testing:** Google Chrome (headless, via Playwright). **Mobile testing:** Chrome mobile emulation (touch, device-pixel ratio 2) at 320, 375 and 425px, plus 768px tablet. Real iOS Safari and Android devices were not available; please check on your own phones after go-live.

### Lighthouse (actual results, run on this machine against the production build)

| | Performance | Accessibility | Best practices | SEO | FCP | LCP | TBT | CLS |
|---|---|---|---|---|---|---|---|---|
| Mobile — **before** (standalone file) | 38 | 97 | 100 | 100 | 8.8 s | 9.1 s | 790 ms | 0 |
| **Mobile — final (production build)** | **93** | **100** | **100** | **100** | 1.1 s | 2.8 s | 180 ms | 0 |
| Desktop — before | 88 | 93 | 100 | 100 | 1.5 s | 1.6 s | 20 ms | 0.02 |
| **Desktop — final** | **99** | **100** | **100** | **100** | 0.3 s | 0.9 s | 0 ms | 0 |

These are lab results with Lighthouse's simulated mobile throttling on a local server. Real-world numbers depend on the host's location and network; repeat the test on the live URL. Full reports: `docs/lighthouse/`.

## Issues found in this audit and fixed

1. **Mobile performance 38 → 93.** The 1.6 MB of inline Base64 is replaced in production by cached, hashed files. Images come in 480px and full sizes chosen by `srcset`, the hero has 960px and 1800px versions with preload, fonts are preloaded, and code is minified. The admin console (≈50 KB) and QR library load only when used.
2. **Mobile menu broken in the production build** (panel collapsed to 70px): layout rules had been moved into the admin stylesheet by mistake. Restored.
3. **Header overflowed by 215px at exactly 768px** (earlier sweeps skipped 768). Fixed.
4. **Content shifted sideways after tapping form fields on phones** (sections with `overflow:hidden` scrolled programmatically). Now `overflow:clip`, with grid columns allowed to shrink. A regression test was added.
5. Long Tamil headings ran past the edge at 320–425px. They now wrap, with smaller Tamil headings on phones.
6. The admin-preview card overflowed on phones. Fixed.
7. Accessibility: two `<h1>` elements (now one); a header logo link whose accessible name didn't match its visible text; contrast failures in the trust strip, footer, gallery note and offers; a link distinguished by colour alone; an inline event handler (removed, so a strict CSP is possible).
8. Encoding bug found while making the share image ("Â·"). Fixed, and the image was checked visually.

## Features (complete)

Public site: welcome screen and Tamil/English switch, header and mobile menu, hero, trust strip, 8 services, about, gallery with 6 filters and a lightbox (keyboard and arrow keys), Google Reviews with a QR code (no invented rating), offers (when active), how ordering works, quotation form (**new optional email field**), two separate consent checkboxes, order tracking, admin preview, FAQ, **Google map (loads only on click, for privacy and speed)**, contact cards, call and WhatsApp links, social links, back-to-top, floating WhatsApp button.

Backend and admin (15 modules): orders with server-side `AK-YYYY-000001` IDs and a 15-stage workflow, payments, customers and events, consent records, communication history, Google review requests, reminders (daily, 10:00 IST), event types, SMS templates (DLT IDs required), SMS campaigns (OTP-gated), campaign history, social settings, promotions, gallery manager.

New in this round: email capture (validated; never erases a stored email), admin password change, an admin CLI (`scripts/admin-user.js`), a backup CLI (`scripts/backup.js`), daily automatic backups with retention, versioned migrations with a pre-migration backup, `robots.txt`, `sitemap.xml`, graceful shutdown and request logging.

## Integrations

| Integration | Status |
|---|---|
| WhatsApp enquiry links (wa.me), call links, Google Maps link and embed, Google review QR, Facebook/Instagram profile links | ✅ Working (no credentials needed) |
| Google rating and review count | Hidden until you enter verified values in the admin panel |
| SMS (MSG91 + DLT), admin OTP, delivery reports | ⏸ **Disabled — needs your credentials** (checklist in `DEPLOY.md`). Code is complete and tested only against mocked provider responses. |
| WhatsApp Business Cloud API | ⏸ Disabled — needs a Meta WhatsApp Business account and approved templates |
| Facebook / Instagram direct publishing | ⏸ Disabled — needs a Meta app, permissions and a Page token; manual sharing works and is never logged as "published" |
| Email sending | Not implemented (email addresses are stored only); no provider was specified |

## Security

* No secrets in the frontend or source: the OTP key comes from the environment (random per process if unset), and the first admin password is used once from the environment and then managed by CLI.
* Admin auth: scrypt-hashed passwords; opaque 256-bit session tokens stored hashed with a 12-hour expiry (no JWT is needed, so there's no JWT secret to leak); lockout after 5 failed logins; password change revokes all sessions.
* Rate limits: enquiries 10 per 10 minutes, consent withdrawal 10 per 10 minutes, tracking 30 per 10 minutes, admin API 600 per 10 minutes (per IP; `TRUST_PROXY` set for the real client IP).
* Server-side validation of every input; prepared statements throughout, with SQL-injection attempts tested; output escaped in the UI.
* Strict **Content-Security-Policy** with SHA-256 hashes for inline scripts (no `unsafe-inline` scripts, no `unsafe-eval`), `frame-ancestors 'none'`, `object-src 'none'`, plus nosniff, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, COOP and HSTS over HTTPS. Zero CSP violations across all tests.
* CORS closed by default in production.
* Request body limits: 64 KB, or 8 MB only on image-upload routes.
* Uploads: PNG/JPEG/WebP only, checked by **file signature**, ≤ 5 MB, random file names, served with their own restrictive CSP.
* Consent cannot be manipulated from the frontend: there is no write endpoint for consent records, admins cannot opt customers in, and opt-outs take effect immediately and are re-checked at send time.
* Database permissions: a single file on a private volume, owned by an unprivileged `node` user in the container (systemd unit: `ProtectSystem=strict`, `NoNewPrivileges`).
* Not done: penetration testing by a third party; a web application firewall or DDoS protection (consider Cloudflare in front of the server).

## SEO

Title and meta description with location and services; canonical URL, Open Graph and Twitter tags with a 1200×630 share image (absolute URLs filled in from `SITE_URL`, so no development URLs ship); **LocalBusiness** JSON-LD (address, phone, hours Mon–Sat 9–8, map, social profiles, 8 services) and **FAQPage** JSON-LD generated from the on-page FAQ; `robots.txt` (disallows `/api/` and `/uploads/`) and `sitemap.xml`; one `<h1>`; alt text on every image; `lang` switches between en and ta. Lighthouse SEO: 100.
Note: the business is listed in **Suranam, Sivagangai District**, as on the site. Chennai was not added, because the site gives no Chennai address.

## Remaining issues / not completed

1. **Not deployed** — blocked on access (see below).
2. **Container image not built here.** Docker Hub is blocked from this workspace, so the `Dockerfile` couldn't be built or linted. The same layout was tested natively from a clean bundle. The first `docker compose up --build` on the server is that file's first real build.
3. External messaging and Meta publishing need your credentials.
4. Eight gallery and service images are AK design mockups (clearly labelled); upload real job photos in Admin → Gallery Manager.
5. Google rating and review link still need entering in the admin panel.
6. Tamil copy should be reviewed by a native speaker.
7. Real-device testing on iPhone and Android after go-live.

## Access required to go live (deployment stops here)

1. **Hosting** — one of:
   * a VPS (Ubuntu 22.04/24.04, ≥ 1 GB RAM), with SSH access or the ability to run the commands in `DEPLOY.md` yourself; **or**
   * a Render or Railway account where you create the service from this project (a paid instance with a persistent disk).
2. **Domain** — the domain name to use, and access to its DNS settings (registrar or Cloudflare) to create the A or CNAME records.
3. **A code repository** (GitHub/GitLab), if you choose Render or Railway. The GitHub token available to this workspace is invalid, so I can't push for you.
4. **Your choices for secrets**, set directly on the host and not sent in chat: the admin username and password, plus later the MSG91 / WhatsApp / Meta keys.

Once the site is deployed, send me the live URL and I'll run the full live verification: HTTPS, mixed content, links, forms, order workflow, consent, admin, and mobile and desktop checks.
