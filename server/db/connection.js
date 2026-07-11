import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chmodSync, existsSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.DATABASE_PATH || join(__dirname, '../../data/cavendo.db');

// Ensure data directory exists
const dataDir = dirname(DB_PATH);
if (DB_PATH !== ':memory:') {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }
  try { chmodSync(dataDir, 0o700); } catch (err) {
    console.warn(`[Database] Unable to set restrictive permissions on ${dataDir}: ${err.message}`);
  }
}

// Create database connection
const db = new Database(DB_PATH);

if (DB_PATH !== ':memory:') {
  try { chmodSync(DB_PATH, 0o600); } catch (err) {
    console.warn(`[Database] Unable to set restrictive permissions on ${DB_PATH}: ${err.message}`);
  }
}

// Enable foreign keys and WAL mode for better concurrency
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

export default db;
