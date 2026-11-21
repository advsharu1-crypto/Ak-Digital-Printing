#!/usr/bin/env node
'use strict';
// Create an admin or reset a password without putting it in an environment variable.
//   node scripts/admin-user.js create <username>
//   node scripts/admin-user.js reset  <username>
// The password is read from the terminal without echo (or from stdin when piped).
const crypto = require('node:crypto'); const path = require('node:path'); const readline = require('node:readline');
const D = require('../src/db');
const [cmd, username] = process.argv.slice(2);
if (!['create', 'reset'].includes(cmd) || !/^[a-zA-Z0-9._-]{3,40}$/.test(username || '')) { console.error('Usage: node scripts/admin-user.js create|reset <username>'); process.exit(2); }
function ask(prompt) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { let d = ''; process.stdin.on('data', (c) => (d += c)); process.stdin.on('end', () => resolve(d.split('\n')[0])); return; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) process.stdout.write(s); };
    rl.question(prompt, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}
(async () => {
  const pw = await ask('New password (min 12 chars): ');
  if (pw.length < 12) { console.error('Password must be at least 12 characters.'); process.exit(1); }
  const db = D.open(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'ak.db'));
  const salt = crypto.randomBytes(16).toString('hex'); const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  const exists = db.prepare('SELECT id FROM admins WHERE username=?').get(username);
  if (cmd === 'create') { if (exists) { console.error('That username already exists. Use "reset".'); process.exit(1); } db.prepare('INSERT INTO admins(username,pass_hash,salt,created_at) VALUES(?,?,?,?)').run(username, hash, salt, new Date().toISOString()); }
  else { if (!exists) { console.error('No such admin.'); process.exit(1); } db.prepare('UPDATE admins SET pass_hash=?, salt=? WHERE id=?').run(hash, salt, exists.id); db.prepare('DELETE FROM sessions WHERE admin_id=?').run(exists.id); }
  console.log(`Admin "${username}" ${cmd === 'create' ? 'created' : 'password reset (all sessions signed out)'}.`);
})();
