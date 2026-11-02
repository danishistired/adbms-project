// QueryLens server: runs SQL on PostgreSQL and returns results + query plans.
require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const { Pool } = require('pg');

const pool = new Pool({
  database: process.env.PGDATABASE || 'querylens',
  options: '-c search_path=library,public -c statement_timeout=20000',
  max: 5,
});

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'd3', 'dist')));

const MAX_ROWS = 500;

// Statements that EXPLAIN can analyze
const EXPLAINABLE = /^\s*(with|select|insert|update|delete|values|table|merge)\b/i;

function isSingleStatement(sql) {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  return !trimmed.includes(';');
}

async function explain(client, sql) {
  if (!EXPLAINABLE.test(sql) || !isSingleStatement(sql)) return null;
  const body = sql.trim().replace(/;\s*$/, '');
  // A savepoint lets us ANALYZE writes without keeping their effects
  await client.query('SAVEPOINT explain_sp');
  try {
    const r = await client.query(`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${body}`);
    return r.rows[0]['QUERY PLAN'][0];
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT explain_sp');
  }
}

function shapeResult(r) {
  return {
    command: r.command,
    rowCount: r.rowCount,
    fields: (r.fields || []).map(f => f.name),
    rows: (r.rows || []).slice(0, MAX_ROWS),
    truncated: (r.rows || []).length > MAX_ROWS,
  };
}

async function logQuery(entry) {
  try {
    await pool.query(
      `INSERT INTO query_log (sql_text, duration_ms, row_count, total_cost, success, error_message)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [entry.sql, entry.duration, entry.rowCount, entry.cost, entry.success, entry.error ?? null]);
  } catch (e) { console.error('log failed:', e.message); }
}

// Run a query: returns result sets and (when possible) the execution plan
app.post('/api/query', async (req, res) => {
  const sql = String(req.body.sql || '').trim();
  if (!sql) return res.status(400).json({ error: 'Empty query' });
  const client = await pool.connect();
  const started = process.hrtime.bigint();
  try {
    await client.query('BEGIN');
    let plan = null, planError = null;
    try { plan = await explain(client, sql); } catch (e) { planError = e.message; }
    const raw = await client.query(sql);
    await client.query('COMMIT');
    const duration = Number(process.hrtime.bigint() - started) / 1e6;
    const results = (Array.isArray(raw) ? raw : [raw]).map(shapeResult);
    const last = results[results.length - 1];
    logQuery({ sql, duration, rowCount: last.rowCount, cost: plan?.Plan?.['Total Cost'] ?? null, success: true });
    res.json({ results, plan, planError, duration });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    const duration = Number(process.hrtime.bigint() - started) / 1e6;
    logQuery({ sql, duration, rowCount: null, cost: null, success: false, error: e.message });
    res.status(400).json({ error: e.message, position: e.position, hint: e.hint });
  } finally {
    client.release();
  }
});

// Index Lab: plan a query, add an index inside a transaction, plan again, roll back
app.post('/api/compare', async (req, res) => {
  const sql = String(req.body.sql || '').trim().replace(/;\s*$/, '');
  const indexSql = String(req.body.indexSql || '').trim().replace(/;\s*$/, '');
  if (!/^create\s+(unique\s+)?index\b/i.test(indexSql)) {
    return res.status(400).json({ error: 'Second statement must be a CREATE INDEX' });
  }
  if (!EXPLAINABLE.test(sql) || !isSingleStatement(sql)) {
    return res.status(400).json({ error: 'Query must be a single SELECT/INSERT/UPDATE/DELETE' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = async () => (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`)).rows[0]['QUERY PLAN'][0];
    await run(); // warm the cache so both runs are fair
    const before = await run();
    await client.query(indexSql);
    const after = await run();
    res.json({ before, after });
  } catch (e) {
    res.status(400).json({ error: e.message });
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
});

// Schema: tables, columns, foreign keys, row counts and indexes
app.get('/api/schema', async (_req, res) => {
  try {
    const [cols, fks, counts, idx, objects] = await Promise.all([
      pool.query(`
        SELECT c.table_name, c.column_name, c.data_type, c.is_nullable,
               EXISTS (SELECT 1 FROM information_schema.key_column_usage k
                       JOIN information_schema.table_constraints t
                         ON t.constraint_name = k.constraint_name AND t.table_schema = k.table_schema
                       WHERE t.constraint_type = 'PRIMARY KEY' AND k.table_schema = c.table_schema
                         AND k.table_name = c.table_name AND k.column_name = c.column_name) AS is_pk
        FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
        WHERE c.table_schema = 'library' AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name, c.ordinal_position`),
      pool.query(`
        SELECT conrelid::regclass::text AS from_table, a.attname AS from_col,
               confrelid::regclass::text AS to_table, af.attname AS to_col
        FROM pg_constraint c
        JOIN pg_attribute a  ON a.attrelid = c.conrelid  AND a.attnum = c.conkey[1]
        JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = c.confkey[1]
        WHERE c.contype = 'f' AND c.connamespace = 'library'::regnamespace`),
      pool.query(`SELECT relname AS table_name, n_live_tup::int AS row_count,
                         pg_size_pretty(pg_total_relation_size(relid)) AS size
                  FROM pg_stat_user_tables WHERE schemaname = 'library'`),
      pool.query(`
        SELECT i.tablename AS table_name, i.indexname AS index_name, i.indexdef,
               EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = i.indexname) AS is_constraint,
               pg_size_pretty(pg_relation_size(('library.' || quote_ident(i.indexname))::regclass)) AS size,
               COALESCE(s.idx_scan, 0)::int AS scans
        FROM pg_indexes i
        LEFT JOIN pg_stat_user_indexes s ON s.indexrelname = i.indexname AND s.schemaname = i.schemaname
        WHERE i.schemaname = 'library' ORDER BY i.tablename, i.indexname`),
      pool.query(`
        SELECT table_name::text AS name, 'view' AS kind FROM information_schema.views WHERE table_schema = 'library'
        UNION ALL
        SELECT matviewname::text, 'materialized view' FROM pg_matviews WHERE schemaname = 'library'
        UNION ALL
        SELECT routine_name::text, 'function' FROM information_schema.routines WHERE routine_schema = 'library'
        UNION ALL
        SELECT DISTINCT trigger_name::text, 'trigger' FROM information_schema.triggers WHERE trigger_schema = 'library'`),
    ]);
    const tables = {};
    for (const c of cols.rows) {
      (tables[c.table_name] ??= { name: c.table_name, columns: [], indexes: [] }).columns.push(c);
    }
    for (const r of counts.rows) if (tables[r.table_name]) Object.assign(tables[r.table_name], r);
    for (const i of idx.rows) if (tables[i.table_name]) tables[i.table_name].indexes.push(i);
    res.json({ tables: Object.values(tables), foreignKeys: fks.rows, objects: objects.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create a simple index from the UI
app.post('/api/indexes', async (req, res) => {
  const { table, columns } = req.body;
  const ident = /^[a-z_][a-z0-9_]*$/;
  if (!ident.test(table || '') || !Array.isArray(columns) || !columns.length || !columns.every(c => ident.test(c))) {
    return res.status(400).json({ error: 'Invalid table or column names' });
  }
  const name = `idx_${table}_${columns.join('_')}`.slice(0, 60);
  try {
    await pool.query(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${columns.join(', ')})`);
    await pool.query(`ANALYZE ${table}`);
    res.json({ created: name });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Drop an index (not ones that back a primary key / unique constraint)
app.delete('/api/indexes/:name', async (req, res) => {
  const name = req.params.name;
  try {
    const r = await pool.query(`
      SELECT 1 FROM pg_indexes i WHERE i.schemaname = 'library' AND i.indexname = $1
      AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = i.indexname)`, [name]);
    if (!r.rowCount) return res.status(400).json({ error: 'Index not found or backs a constraint' });
    await pool.query(`DROP INDEX library.${JSON.stringify(name)}`);
    res.json({ dropped: name });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Query history (stored in PostgreSQL)
app.get('/api/history', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT log_id, sql_text, ran_at, duration_ms::float AS duration_ms, row_count,
              total_cost::float AS total_cost, success, error_message
       FROM query_log ORDER BY log_id DESC LIMIT 100`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/history', async (_req, res) => {
  try { await pool.query('TRUNCATE query_log'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`QueryLens running at http://localhost:${port}`));
