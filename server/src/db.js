'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const MIGRATIONS = path.join(__dirname, 'migrations');

function createPool(connectionString, { max = 10 } = {}) {
  if (!connectionString) throw new Error('No database URL configured (BW_DATABASE_URL).');
  return new Pool({ connectionString, max, idleTimeoutMillis: 30000, application_name: 'benchwise-server' });
}

/** Runs one function in a transaction; rolls back on any error. */
async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Applies migrations in order (001_x.sql, 002_y.sql, ...), each in its own
 * transaction, recording what ran. Safe to run on every install/upgrade.
 * Must run as the schema owner, not the service's role.
 */
async function migrate(pool, { dir = MIGRATIONS, log = () => {} } = {}) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await pool.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
  const files = fs.readdirSync(dir).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await tx(pool, async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    });
    applied.push(file);
    log(`applied ${file}`);
  }
  // The service's role reads which migrations ran (for /healthz).
  await pool.query(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'benchwise_server_app') THEN
      GRANT SELECT ON schema_migrations TO benchwise_server_app;
    END IF; END $$`);
  return applied;
}

module.exports = { createPool, tx, migrate };
