# AK Digital Printing — Website + Admin Backend

```
public/AK-Digital-Printing-Final.html   ← the deliverable: one self-contained file
site/                                   ← editable sources for that file (run build.py)
backend/                                ← Node.js + SQLite server (orders, consent, admin API, messaging)
tests/                                  ← browser end-to-end tests (Playwright + Chrome)
docs/                                   ← testing report, admin module list, screenshots
```

## Source of truth

The original localhost project no longer exists. This project was built from the exported HTML file, keeping its design, logo, content and its one original image. `backend/` implements every server-side requirement. `docs/FEATURES.md` lists exactly what works from the HTML file alone and what needs the server or external accounts.

## 1. Open the website without a server

Double-click `AK-Digital-Printing-Final.html`. Everything below works with no server:

* the welcome screen and Tamil/English switch, navigation, the mobile menu and animations
* the services, about and gallery sections, gallery filters and the lightbox (with keyboard support)
* the Google Reviews section and its QR code, FAQ, social links, back-to-top button
* quotation-form validation, including the **two separate consent checkboxes**

Without a backend the form **does not create an Order ID**. It opens WhatsApp with the enquiry, including both consent choices, and clearly says that no Order ID has been issued.

## 2. Build and run (production)

Requires Node.js 22.5+ and Python 3 with Pillow (build only).

```bash
npm ci                      # build tools (terser, csso)
python3 site/build.py       # -> dist/ (production site) + public/AK-Digital-Printing-Final.html (standalone)
cd backend && npm ci --omit=dev
NODE_ENV=production SITE_URL=https://yourdomain.in ADMIN_USERNAME=akadmin ADMIN_PASSWORD='a-long-password' node src/server.js
# http://localhost:8787  (site)   ·   http://localhost:8787/#admin  (admin console)
```

Deployment, HTTPS, DNS and the go-live checklist: **`DEPLOY.md`**. Results of this release: **`FINAL-DELIVERY-REPORT.md`**.

Tests: `npm test` (backend, 21 tests), `python3 tests/e2e_standalone.py <html> <outdir>`, `python3 tests/e2e_backend.py <url> <html> <outdir>` and `python3 tests/e2e_responsive.py <url> <outdir>` (browser tests; need Playwright and Chrome).

### Environment variables

| Variable | Purpose |
|---|---|
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Creates the first admin on first start only (≥ 12 chars in production, scrypt-hashed). Remove it afterwards; use `node scripts/admin-user.js reset <user>`. |
| `PORT`, `DB_FILE`, `UPLOADS_DIR`, `PUBLIC_DIR` | Server port, SQLite file, banner uploads folder, website folder. |
| `CORS_ORIGINS` | Comma-separated allowed origins. Default: none in production (site and API share one origin); `*` in development. Use `null` to allow the standalone HTML file. |
| `SITE_URL` | Final `https://` URL; used for canonical, Open Graph, `robots.txt` and `sitemap.xml`. |
| `TRUST_PROXY` | Set to `1` behind Caddy, Render or Railway, so rate limits see the real client IP. |
| `BACKUP_DIR`, `BACKUP_RETENTION` | Daily backups (default retention 14). |
| `OTP_PEPPER`, `WEBHOOK_SECRET` | Random secrets (`openssl rand -hex 32`). |
| `MSG91_AUTHKEY` | **SMS provider** (MSG91 Flow API, DLT). Without it, all SMS sending is disabled. |
| `ADMIN_OTP_MOBILE`, `OTP_TEMPLATE_ID`, `OTP_DLT_TEMPLATE_ID`, `OTP_SENDER_ID`, `OTP_PEPPER` | **Admin OTP** for bulk campaigns (sent through MSG91 to the admin's mobile). |
| `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_VERIFY_TOKEN` | **WhatsApp Business (Cloud API)** template messages + status webhook. |
| `WEBHOOK_SECRET` | Protects delivery-report webhooks: `POST /api/webhooks/sms-dlr?secret=…`, `POST /api/webhooks/whatsapp?secret=…`. |
| `META_PAGE_ID`, `IG_USER_ID`, `META_PAGE_TOKEN`, `PUBLIC_BASE_URL` | **Direct Facebook / Instagram publishing** (Meta app with `pages_manage_posts` / `instagram_content_publish`). |

## 3. Provider configuration (needs your real accounts)

Nothing is simulated. Until a provider is configured, the related buttons are disabled, a warning explains what is missing, and any attempted message is logged as **not sent** with the reason.

1. **DLT registration (India, TRAI TCCCPR).** Register as a Principal Entity on an operator DLT portal (Jio, Airtel, Vi or BSNL). Register a 6-letter **sender ID/header**, then register each message **template** in the correct category: service-implicit for order updates and review requests, promotional for offers and reminders.
2. **MSG91.** Create a Flow/template for each DLT template, using variables with the same names as in the admin template (`name`, `order_id`, `status`, `review_link`, …). Set `MSG91_AUTHKEY`. Point MSG91's delivery-report webhook at `/api/webhooks/sms-dlr?secret=…`.
3. In **Admin → SMS Templates**, enter the DLT template ID, sender ID and MSG91 template ID for each template. A template missing these IDs cannot be sent.
4. **OTP.** Create a DLT/MSG91 OTP template with an `otp` variable and set `OTP_TEMPLATE_ID` and `ADMIN_OTP_MOBILE`.
5. **WhatsApp (optional).** Use approved template names in the WhatsApp fields of each template, and set `WA_*`. Subscribe the webhook to `/api/webhooks/whatsapp`.
6. **Meta publishing (optional).** Until it is configured, use the manual share buttons. These are recorded as "share window opened", never as "published".

Statuses mean exactly this: **pending** = being handed to the provider; **sent** = the provider accepted it; **delivered** = the provider's delivery report confirmed it; **failed** = the provider rejected it; **not sent** = blocked before reaching a provider (no consent, no provider, invalid number).

## 4. Consent rules (enforced on the server)

* `POST /api/enquiries` refuses to create an order unless `consent_operational === true`, the consent text version matches, and `consent_promotional` is an explicit `true`/`false`.
* An Order ID (`AK-YYYY-000001`, per-year counter, IST year, inside a database transaction) is generated **only after** that check passes.
* Each order stores both consent records (type, status, version, full text, source, IP, user agent, timestamp).
* An enquiry without promotional consent **does not** remove an earlier opt-in. Only an explicit withdrawal does.
* Withdrawal (customer self-service with mobile + Order ID, or admin on the customer's request) takes effect immediately. Promotional consent is re-checked for every message at send time. Order updates continue.
* Promotional sends are only allowed between 09:00 and 21:00 IST.

## Images

All images are embedded in the HTML (see `docs/IMAGE-VERIFICATION.md`): the original studio photo, 9 crops of it, and 8 AK design mockups labelled as such (source: `site/images/mockups-source.html`). No stock or external images are used. To show real work, upload job photos in **Admin → Gallery Manager**. To change a built-in image, replace the file in `site/images/` (same name, WebP) and rebuild.

## Rebuilding the HTML

Edit `site/index.src.html`, `site/extra.css`, `site/admin.css`, `site/public.js` or `site/admin.js`, then run `python3 site/build.py`. The fonts (DM Sans, Manrope — SIL OFL), Noto Sans Tamil (SIL OFL), the QR library (qrcode-generator, MIT) and all images are inlined, so the file makes no external requests.

## Vercel (front end only)

`vercel.json` + `scripts/build-vercel.js` publish `public/AK-Digital-Printing-Final.html` as a static site (with a hash-based CSP and security headers). **Vercel has no persistent disk, so the backend (orders, admin, SMS, uploads) does not run there.** On Vercel the quotation form opens WhatsApp and says no Order ID was issued; admin sign-in and order tracking need the backend hosted elsewhere (Render, Railway or a VPS, see `DEPLOY.md`).

`branding/` holds the logo, favicon and social-image files. `dist/` (the optimised build) and `site/` (sources) are not in this repository yet.
