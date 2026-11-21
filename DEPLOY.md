# Deploying AK Digital Printing

## Architecture (decides the host)

One Node.js 22 process serves **both** the website (`dist/`) and the API, with a **SQLite database on disk** (`/data/ak.db`, plus uploads and backups in `/data`). The host must therefore provide:

* a long-running Node process (not serverless functions)
* a **persistent disk** that survives redeploys
* HTTPS and a custom domain

| Platform | Fits? | Notes |
|---|---|---|
| **VPS** (any provider, e.g. a 1 vCPU / 1 GB instance in Mumbai or Bengaluru) + Docker + Caddy | ✅ **Recommended** | Lowest cost, India region, automatic HTTPS via Caddy. Files: `Dockerfile`, `deploy/docker-compose.yml`, `deploy/Caddyfile` (or `deploy/ak-digital-printing.service` without Docker). |
| Render (Starter plan + disk) | ✅ | `deploy/render.yaml`. Persistent disks need a paid plan; the nearest region is Singapore. |
| Railway (with a volume mounted at `/data`) | ✅ | Use the `Dockerfile`; add a volume at `/data`. |
| Vercel / Netlify | ❌ | Serverless with no persistent disk: SQLite, uploads and the reminder scheduler would not work. Deploying only the front end there would break orders, consent and admin. |

## Option A — VPS with Docker (recommended)

```bash
# on your computer (needs Node 22 and Python 3 with Pillow)
npm ci && python3 site/build.py           # builds dist/ and the standalone HTML
# copy the project to the server (git clone or scp), then on the server:
cp deploy/.env.example deploy/.env && nano deploy/.env   # fill DOMAIN, SITE_URL, ADMIN_*, OTP_PEPPER, WEBHOOK_SECRET
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f app   # expect "backend listening"
```

DNS: create an **A record** for `yourdomain.in` (and `www`) pointing to the server's IP **before** starting, so Caddy can issue the certificate. Open ports 80 and 443.

After the first sign-in, remove `ADMIN_PASSWORD` from `deploy/.env`. Manage passwords with:
`docker compose -f deploy/docker-compose.yml exec app node scripts/admin-user.js reset akadmin`

## Option B — Render

1. Push this project to a GitHub/GitLab repository, **including `dist/`** (or add a build step that runs `python3 site/build.py`).
2. Render → New → Blueprint → select the repository (`deploy/render.yaml`), or create a Web Service with the Dockerfile and a 1 GB disk mounted at `/data`.
3. Set `SITE_URL`, `ADMIN_USERNAME` and `ADMIN_PASSWORD`. Add the custom domain in Render and create the CNAME it shows at your DNS provider.

## Go-live checklist

- [ ] `SITE_URL` is the final `https://` domain (canonical URL, sitemap and Open Graph come from it)
- [ ] DNS points to the host; `https://yourdomain.in` shows a valid certificate; `http://` redirects to `https://`
- [ ] `/api/health` returns `{"ok":true}`; `/robots.txt` and `/sitemap.xml` show the real domain
- [ ] Submit a test enquiry → Order ID shown → visible in Admin → Order Management → delete or cancel the test order
- [ ] Admin password changed from the bootstrap value; `ADMIN_PASSWORD` removed from the environment
- [ ] Admin → Google Review Management: enter the real rating, review count, "checked on" date and the Google review link
- [ ] Backups: `/data/backups` receives a daily file; copy them off the server regularly (e.g. a weekly download)
- [ ] Google Search Console: add the domain and submit `https://yourdomain.in/sitemap.xml`
- [ ] Google Business Profile: set the website field to the new domain

## External integrations (all disabled until configured)

| Integration | What you need | Where |
|---|---|---|
| SMS order updates, reminders, campaigns | DLT Principal Entity registration (Jio/Airtel/Vi/BSNL portal), 6-letter sender ID, approved templates (service + promotional), an MSG91 account and auth key | `MSG91_AUTHKEY`; template IDs in Admin → SMS Templates |
| Admin OTP for bulk campaigns | A DLT-approved OTP template + MSG91 flow with an `otp` variable, the admin mobile number | `ADMIN_OTP_MOBILE`, `OTP_TEMPLATE_ID`, `OTP_DLT_TEMPLATE_ID`, `OTP_SENDER_ID` |
| Delivery reports | MSG91 webhook → `https://yourdomain.in/api/webhooks/sms-dlr?secret=WEBHOOK_SECRET` | `WEBHOOK_SECRET` |
| WhatsApp Business messages | Meta Business account, WhatsApp Cloud API phone number ID, permanent token, approved templates; webhook → `/api/webhooks/whatsapp?secret=…` | `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_VERIFY_TOKEN` |
| Facebook / Instagram direct publishing | Meta app with `pages_manage_posts` / `instagram_content_publish`, Page ID, Instagram business account ID, long-lived Page token | `META_PAGE_ID`, `IG_USER_ID`, `META_PAGE_TOKEN`, `PUBLIC_BASE_URL` |
| Google | No API key needed: the review link, Maps link and QR code are configured in the admin panel | Admin → Google Review Management |

## Operations

* **Logs:** one JSON line per request (method, path, status, duration; no personal data). Errors go to stderr.
* **Backups:** a daily `VACUUM INTO` backup at or after 02:00 IST, keeping `BACKUP_RETENTION` (14) files, plus an automatic backup before every schema migration. Manual backup: `node scripts/backup.js`.
* **Restore:** stop the app, copy a backup file over `/data/ak.db` (remove the `ak.db-wal` and `ak.db-shm` files), then start the app.
* **Upgrades:** migrations are additive and recorded in `schema_migrations`; existing customers, orders and consent records are never dropped or rewritten. This was tested by upgrading a database created by the previous release.
* **Shutdown:** SIGTERM stops the scheduler, finishes open requests and closes the database cleanly.
