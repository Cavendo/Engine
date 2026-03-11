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
 *   DB_DRIVER=mysql — uses mysql2/promise Pool
 */

import { createSqliteAdapter } from './sqliteAdapter.js';

function parseMysqlDatabaseUrl(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('Invalid DATABASE_URL for MySQL');
  }

  if (!['mysql:', 'mysql2:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL must use mysql:// (or mysql2://) when DB_DRIVER=mysql');
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!database) {
    throw new Error('DATABASE_URL must include a database name path when DB_DRIVER=mysql');
  }

  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    database
  };
}

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
} else if (DB_DRIVER === 'mysql') {
  let mysql;
  try {
    ({ default: mysql } = await import('mysql2/promise'));
  } catch {
    throw new Error("mysql2 is not installed. Install optional dependency 'mysql2' to use DB_DRIVER=mysql.");
  }
  const { createMysqlAdapter } = await import('./mysqlAdapter.js');

  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is required when DB_DRIVER=mysql');
  }

  const poolMax = parseInt(process.env.MYSQL_POOL_MAX, 10) || 10;
  const charset = process.env.MYSQL_CHARSET || 'utf8mb4';
  const timezone = process.env.MYSQL_TIMEZONE || 'Z';
  const sslMode = process.env.MYSQL_SSL_MODE || '';
  const ssl = sslMode === 'required' ? {} : undefined;
  const conn = parseMysqlDatabaseUrl(DATABASE_URL);

  const pool = mysql.createPool({
    ...conn,
    connectionLimit: poolMax,
    waitForConnections: true,
    queueLimit: 0,
    timezone,
    charset,
    multipleStatements: true,
    ...(ssl ? { ssl } : {})
  });

  adapter = createMysqlAdapter(pool);
} else if (DB_DRIVER === 'sqlite') {
  // Import the existing connection singleton
  const { default: rawDb } = await import('./connection.js');
  adapter = createSqliteAdapter(rawDb);
} else {
  throw new Error(`Unknown DB_DRIVER: ${DB_DRIVER}. Use 'sqlite', 'postgres', or 'mysql'.`);
}

export default adapter;
