// Creates the database (if missing), then loads schema + seed data.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function main() {
  const dbName = process.env.PGDATABASE || 'querylens';

  const admin = new Client({ database: 'postgres' });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rowCount === 0) {
    await admin.query(`CREATE DATABASE "${dbName}"`);
    console.log(`Created database ${dbName}`);
  }
  await admin.end();

  const db = new Client({ database: dbName });
  await db.connect();
  for (const file of ['schema.sql', 'seed.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', file), 'utf8');
    console.log(`Running ${file}...`);
    await db.query(sql);
  }
  const { rows } = await db.query(`
    SELECT relname AS table, n_live_tup AS rows
    FROM pg_stat_user_tables WHERE schemaname = 'library' ORDER BY relname`);
  console.table(rows);
  await db.end();
  console.log('Setup complete. Run: npm start');
}

main().catch(err => { console.error('Setup failed:', err.message); process.exit(1); });
