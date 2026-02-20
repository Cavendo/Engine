import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

/**
 * Lightweight migration runner for Cavendo Engine.
 * Owns the schema_migrations table exclusively (not in schema.sql).
 * Scans server/db/migrations/*.sql in lexicographic order, skips already-applied, runs in transaction.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function runMigrations(db) {
  // Ensure schema_migrations table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Get already-applied versions
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version)
  );

  // Read migration files sorted lexicographically
  let files;
  try {
    files = readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();
  } catch {
    // No migrations directory — nothing to do
    return;
  }

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
    console.log(`[Migrator] Applying migration: ${file}`);

    // SQLite ALTER TABLE cannot be rolled back in a transaction, but we still
    // wrap for consistency. Individual ALTER TABLE statements are atomic in SQLite.
    const runMigration = db.transaction(() => {
      // Execute each statement separately (SQLite exec handles multiple statements)
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
    });

    try {
      runMigration();
      console.log(`[Migrator] Applied: ${file}`);
    } catch (err) {
      // ALTER TABLE ADD COLUMN fails if column already exists — treat as idempotent
      if (err.message.includes('duplicate column name')) {
        console.log(`[Migrator] Skipped (columns already exist): ${file}`);
        db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(version);
      } else {
        console.error(`[Migrator] Failed to apply ${file}:`, err.message);
        throw err;
      }
    }
  }
}
