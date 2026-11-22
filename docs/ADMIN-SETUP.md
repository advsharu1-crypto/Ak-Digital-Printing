# Staff admin panel (`/admin`) — setup

Enquiry inbox for staff at `https://www.akdigitalprinters.com/admin`. Serverless functions in `api/`, Postgres (Neon) for storage.
Sign-in: **Google (allow-listed emails)** and/or **username + password**. No OTP. Customers never see this page.

## One-time setup (Vercel project → Settings)
1. **Storage → Create → Neon (Postgres)** and connect it to the project (adds `DATABASE_URL`). Tables are created automatically.
2. **Environment Variables** (Production), entered directly in Vercel — never in chat or Git:
   | Name | Value |
   |---|---|
   | `SESSION_SECRET` | random string, 32+ chars (signs login cookies) |
   | `ADMIN_USERNAME` | optional, default `akadmin` |
   | `ADMIN_PASSWORD` | 12+ characters |
   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | from Google Cloud → APIs & Services → Credentials → OAuth client (Web). Authorised redirect URI: `https://www.akdigitalprinters.com/api/auth/google/callback` |
   | `ADMIN_GOOGLE_EMAILS` | comma-separated Gmail addresses allowed to sign in |
   | `ADMIN_SESSION_VERSION` | optional; change the number to sign everyone out |
3. Redeploy. Only the sign-in methods that are fully configured appear on the login page.

## Behaviour
- Website form sends the enquiry by email (Web3Forms) **and** saves it to the database; success if either works.
- 5 failed password attempts per IP or username → 15-minute lock. Sessions last 12 h, HttpOnly + Secure + SameSite=Lax.
- Admin pages are `noindex`, `no-store`, strict CSP. All changes/deletes/exports are written to `audit_log`.
- Local test: `npm test`; local run: `npm run build && AK_TEST_PGLITE=1 SESSION_SECRET=... ADMIN_PASSWORD=... npm run dev`.
