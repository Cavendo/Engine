import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.DATABASE_PATH || join(__dirname, '../../data/cavendo.db');

// Ensure data directory exists
const dataDir = dirname(DB_PATH);
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

// Create database connection
const db = new Database(DB_PATH);

// Enable foreign keys and WAL mode for better concurrency
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

export default db;
