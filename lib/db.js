'use strict';
// Postgres access. Production: Neon (HTTP driver, works in serverless). Tests/dev: in-memory PGlite (AK_TEST_PGLITE=1).
let client = null; let ready = null;

async function getClient() {
  if (client) return client;
  if (process.env.AK_TEST_PGLITE === '1') {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    client = { query: async (t, p = []) => (await pg.query(t, p)).rows };
    return client;
  }
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) return null;
  const { neon } = require('@neondatabase/serverless');
  const sql = neon(url);
  client = { query: (t, p = []) => sql.query(t, p) };
  return client;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS enquiries (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT, service TEXT NOT NULL, size TEXT, quantity INTEGER, needed_by DATE, details TEXT,
    consent_operational BOOLEAN NOT NULL, consent_promotional BOOLEAN NOT NULL, consent_version TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'website', user_agent TEXT, ip_hash TEXT,
    status TEXT NOT NULL DEFAULT 'New', note TEXT, handled_by TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_enq_created ON enquiries (created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_enq_status ON enquiries (status)',
  `CREATE TABLE IF NOT EXISTS rate_events (id BIGSERIAL PRIMARY KEY, key TEXT NOT NULL, kind TEXT NOT NULL, ok BOOLEAN NOT NULL DEFAULT false, at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS idx_rate_key ON rate_events (key, kind, at)',
  `CREATE TABLE IF NOT EXISTS audit_log (id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), actor TEXT NOT NULL, action TEXT NOT NULL, ref TEXT, detail TEXT)`
];

/** Returns a ready client (schema created on first use), or null when no database is configured. */
async function db() {
  const c = await getClient();
  if (!c) return null;
  if (!ready) ready = (async () => { for (const s of SCHEMA) await c.query(s); })().catch((e) => { ready = null; throw e; });
  await ready;
  return c;
}
const dbConfigured = () => process.env.AK_TEST_PGLITE === '1' || !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);

/** Count events for a key in the last N minutes. */
async function countEvents(c, key, kind, minutes, onlyFailed = false) {
  const r = await c.query(`SELECT COUNT(*)::int AS n FROM rate_events WHERE key=$1 AND kind=$2 AND at > now() - ($3 || ' minutes')::interval ${onlyFailed ? 'AND ok=false' : ''}`, [key, kind, String(minutes)]);
  return r[0].n;
}
async function addEvent(c, key, kind, ok) {
  await c.query('INSERT INTO rate_events (key,kind,ok) VALUES ($1,$2,$3)', [key, kind, !!ok]);
  if (Math.random() < 0.02) await c.query("DELETE FROM rate_events WHERE at < now() - interval '2 days'");
}
const audit = (c, actor, action, ref, detail) => c.query('INSERT INTO audit_log (actor,action,ref,detail) VALUES ($1,$2,$3,$4)', [actor, action, ref == null ? null : String(ref), detail || null]);

module.exports = { db, dbConfigured, countEvents, addEvent, audit };
