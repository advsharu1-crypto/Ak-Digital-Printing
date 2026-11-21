#!/usr/bin/env node
'use strict';
// One-off consistent backup of the live database (safe while the server runs).
//   BACKUP_DIR=/data/backups node scripts/backup.js
const path = require('node:path'); const D = require('../src/db');
const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'ak.db');
const db = D.open(file);
console.log(D.backup(db, process.env.BACKUP_DIR || path.join(path.dirname(file), 'backups'), 'manual'));
