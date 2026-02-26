/**
 * Database Adapter Factory
 *
 * Returns the appropriate adapter based on DB_DRIVER env var.
 * Default is 'sqlite' for backward compatibility.
 *
 * Usage:
 *   import db from './db/adapter.js';
 *   const row = await db.one('SELECT * FROM tasks WHERE id = ?', [id]);
 *
 * Environment:
 *   DB_DRIVER=sqlite (default) — uses better-sqlite3
 *   DB_DRIVER=postgres — uses pg Pool
 */

import { createSqliteAdapter } from './sqliteAdapter.js';

const DB_DRIVER = process.env.DB_DRIVER || 'sqlite';

let adapter;

if (DB_DRIVER === 'postgres') {
  // Dynamic import to avoid requiring pg when using SQLite
  const { default: pg } = await import('pg');
  const { createPgAdapter } = await import('./pgAdapter.js');

  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is required when DB_DRIVER=postgres');
  }

  // Optional pool configuration
  const poolMin = parseInt(process.env.PG_POOL_MIN, 10) || 2;
  const poolMax = parseInt(process.env.PG_POOL_MAX, 10) || 10;

  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    min: poolMin,
    max: poolMax,
  });

  // Optional: parse timestamps as ISO strings instead of Date objects
  if (process.env.PG_PARSE_TIMESTAMPS === 'iso') {
    // TIMESTAMP (1114) and TIMESTAMPTZ (1184) type OIDs
    pg.types.setTypeParser(1114, (val) => val); // TIMESTAMP → string
    pg.types.setTypeParser(1184, (val) => val); // TIMESTAMPTZ → string
  }

  adapter = createPgAdapter(pool);
} else if (DB_DRIVER === 'sqlite') {
  // Import the existing connection singleton
  const { default: rawDb } = await import('./connection.js');
  adapter = createSqliteAdapter(rawDb);
} else {
  throw new Error(`Unknown DB_DRIVER: ${DB_DRIVER}. Use 'sqlite' or 'postgres'.`);
}

export default adapter;
