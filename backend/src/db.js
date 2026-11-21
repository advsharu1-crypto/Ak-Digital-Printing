'use strict';
// SQLite schema for the AK Digital Printing backend (Node 22+ built-in node:sqlite).
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const CONSENT_VERSION = 'v1-2026-11';
const OPERATIONAL_TEXT = 'I agree to receive necessary communications regarding my enquiry and order, including quotation updates, order confirmation, artwork approval, payment updates, order tracking, and delivery or pickup notifications.';
const PROMOTIONAL_TEXT = 'I agree to receive promotional SMS, WhatsApp messages, special offers, festival discounts, and birthday or anniversary reminders.';

const ORDER_STAGES = [
  'Enquiry Received', 'Quotation Prepared', 'Awaiting Quotation Approval', 'Quotation Approved',
  'Awaiting Artwork Approval', 'Artwork Approved', 'Advance Payment Pending', 'Advance Payment Received',
  'In Production', 'Quality Check', 'Ready for Collection or Dispatch', 'Out for Delivery',
  'Delivered or Collected', 'Order Completed', 'Cancelled'
];

const DEFAULT_EVENT_TYPES = [
  ['Birthday', 1], ['Wedding Anniversary', 1], ['Wedding', 0], ['First Communion', 0],
  ['Ear-Piercing Ceremony', 0], ['School Function', 0], ['Festival', 1], ['Custom Event', 0]
];

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES admins(id), expires_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL, category TEXT NOT NULL DEFAULT 'Retail',
    preferred_channel TEXT NOT NULL DEFAULT 'sms', promo_consent INTEGER NOT NULL DEFAULT 0, promo_consent_updated_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS order_counters (year INTEGER PRIMARY KEY, last INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), service TEXT NOT NULL, size TEXT, quantity INTEGER,
    needed_by TEXT, details TEXT, status TEXT NOT NULL, quotation_amount REAL, artwork_status TEXT NOT NULL DEFAULT 'Not submitted',
    artwork_note TEXT, production_progress INTEGER NOT NULL DEFAULT 0, fulfilment TEXT NOT NULL DEFAULT 'pickup', delivery_address TEXT,
    source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS order_status_history (id INTEGER PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), from_status TEXT, to_status TEXT NOT NULL, note TEXT, changed_by TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), kind TEXT NOT NULL CHECK(kind IN ('advance','balance')), amount REAL NOT NULL CHECK(amount>0), method TEXT NOT NULL, reference TEXT, verified INTEGER NOT NULL DEFAULT 0, verified_by TEXT, verified_at TEXT, note TEXT, recorded_by TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS consent_records (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), order_id TEXT REFERENCES orders(id), consent_type TEXT NOT NULL CHECK(consent_type IN ('operational','promotional')), status TEXT NOT NULL CHECK(status IN ('granted','not_given','withdrawn')), consent_version TEXT NOT NULL, consent_text TEXT, source TEXT NOT NULL, ip TEXT, user_agent TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sms_templates (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL CHECK(category IN ('service','promotional','otp')), channel TEXT NOT NULL CHECK(channel IN ('sms','whatsapp')), body TEXT NOT NULL, variables TEXT NOT NULL DEFAULT '[]', dlt_template_id TEXT, sender_id TEXT, provider_template_id TEXT, wa_template_name TEXT, wa_language TEXT DEFAULT 'en', trigger_status TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS campaigns (id INTEGER PRIMARY KEY, name TEXT NOT NULL, template_id INTEGER NOT NULL REFERENCES sms_templates(id), channel TEXT NOT NULL, audience TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'sms', promotion_id INTEGER, status TEXT NOT NULL DEFAULT 'draft', eligible_count INTEGER, created_by TEXT NOT NULL, created_at TEXT NOT NULL, executed_at TEXT, finished_at TEXT, error TEXT);
  CREATE TABLE IF NOT EXISTS otps (id INTEGER PRIMARY KEY, purpose TEXT NOT NULL, ref_id TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, consumed_at TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS communications (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), order_id TEXT, channel TEXT NOT NULL, purpose TEXT NOT NULL, to_number TEXT NOT NULL, body TEXT, status TEXT NOT NULL CHECK(status IN ('pending','sent','delivered','failed','not_sent')), provider TEXT, provider_message_id TEXT, error TEXT, campaign_id INTEGER, review_request_id INTEGER, reminder_log_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_comm_pmid ON communications(provider_message_id);
  CREATE TABLE IF NOT EXISTS review_requests (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), order_id TEXT, channel TEXT NOT NULL, status TEXT NOT NULL, communication_id INTEGER, error TEXT, requested_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS event_types (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, recurring INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, intervals TEXT NOT NULL DEFAULT '[30,15,7]', template_id INTEGER REFERENCES sms_templates(id), is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS customer_events (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), event_type_id INTEGER NOT NULL REFERENCES event_types(id), event_date TEXT NOT NULL, label TEXT, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS reminder_runs (id INTEGER PRIMARY KEY, run_date TEXT NOT NULL, trigger TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, candidates INTEGER DEFAULT 0, sent INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, error TEXT);
  CREATE TABLE IF NOT EXISTS reminder_log (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES reminder_runs(id), customer_event_id INTEGER NOT NULL REFERENCES customer_events(id), interval_days INTEGER NOT NULL, occurrence_date TEXT NOT NULL, status TEXT NOT NULL, communication_id INTEGER, error TEXT, created_at TEXT NOT NULL, UNIQUE(customer_event_id, interval_days, occurrence_date));
  CREATE TABLE IF NOT EXISTS promotions (id INTEGER PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'Festival Offer', description TEXT, offer_text TEXT, banner_file TEXT, start_date TEXT NOT NULL, end_date TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS gallery_items (id INTEGER PRIMARY KEY, title TEXT NOT NULL, categories TEXT NOT NULL, image_file TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS social_posts (id INTEGER PRIMARY KEY, promotion_id INTEGER REFERENCES promotions(id), platform TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('direct','manual_share_opened')), status TEXT NOT NULL, external_id TEXT, error TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  const now = new Date().toISOString();
  const seedSetting = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
  for (const [k, v] of Object.entries({
    google_rating: '', google_review_count: '', google_rating_verified_at: '',
    google_review_url: '', google_maps_url: 'https://maps.app.goo.gl/gnjBeE8WZoC1XLX36?g_st=aw',
    social_facebook: 'https://facebook.com/akdigitalprintingsuranam',
    social_instagram: 'https://instagram.com/akdigitalprinting',
    social_whatsapp: 'https://wa.me/919585232399',
    notify_on_status_change: '1', default_reminder_template_id: ''
  })) seedSetting.run(k, v);
  const seedType = db.prepare('INSERT OR IGNORE INTO event_types(name,recurring,enabled,intervals,is_default,created_at,updated_at) VALUES(?,?,1,\'[30,15,7]\',1,?,?)');
  for (const [n, r] of DEFAULT_EVENT_TYPES) seedType.run(n, r, now, now);
  migrate(db, file);
  return db;
}

// ---------- additive, versioned migrations (never drop or rewrite data) ----------
const MIGRATIONS = [
  { id: 1, name: 'customers.email', up: (db) => { if (!db.prepare('PRAGMA table_info(customers)').all().some((c) => c.name === 'email')) db.exec('ALTER TABLE customers ADD COLUMN email TEXT'); } },
  { id: 2, name: 'expired-session index', up: (db) => db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at)') }
];
function migrate(db, file) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const done = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
  const pending = MIGRATIONS.filter((m) => !done.has(m.id));
  if (!pending.length) return;
  const hasData = db.prepare('SELECT COUNT(*) c FROM customers').get().c > 0;
  if (hasData && file !== ':memory:') { const b = backup(db, process.env.BACKUP_DIR || path.join(path.dirname(file), 'backups'), 'pre-migration'); console.log('[ak] backup before migration:', b); }
  for (const m of pending) {
    db.exec('BEGIN IMMEDIATE');
    try { m.up(db); db.prepare('INSERT INTO schema_migrations(id,name,applied_at) VALUES(?,?,?)').run(m.id, m.name, new Date().toISOString()); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}

/** Consistent online backup using SQLite VACUUM INTO. Returns the backup file path. */
function backup(db, dir, label = 'auto', keep = Number(process.env.BACKUP_RETENTION || 14)) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(dir, `ak-${label}-${stamp}.db`);
  db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  const old = fs.readdirSync(dir).filter((f) => f.startsWith(`ak-${label}-`) && f.endsWith('.db')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - keep))) fs.unlinkSync(path.join(dir, f));
  return out;
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { open, tx, backup, CONSENT_VERSION, OPERATIONAL_TEXT, PROMOTIONAL_TEXT, ORDER_STAGES };
