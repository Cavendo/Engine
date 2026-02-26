import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isDuplicateColumn, isUniqueViolation } from './errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

/**
 * Lightweight migration runner for Cavendo Engine.
 * Owns the schema_migrations table exclusively (not in schema.sql).
 * Scans server/db/migrations/*.sql in lexicographic order, skips already-applied, runs in transaction.
 *
 * @param {object} db - Database adapter (one/many/exec/insert/run/tx/dialect)
 */
export async function runMigrations(db) {
  // Ensure schema_migrations table exists
  await db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (${db.dialect === 'postgres' ? 'NOW()' : "datetime('now')"})
    )
  `);

  // Get already-applied versions
  const appliedRows = await db.many('SELECT version FROM schema_migrations');
  const applied = new Set(appliedRows.map(r => r.version));

  // Determine migration directory based on dialect
  const migrationsDir = db.dialect === 'postgres'
    ? join(MIGRATIONS_DIR, 'pg')
    : MIGRATIONS_DIR;

  // Read migration files sorted lexicographically
  let files;
  try {
    files = readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();
  } catch {
    // No migrations directory — nothing to do
    return;
  }

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;

    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    console.log(`[Migrator] Applying migration: ${file}`);

    try {
      await db.tx(async (tx) => {
        // Execute migration SQL (may contain multiple statements).
        // tx.run() uses raw exec for multi-statement support.
        await tx.run(sql);
        await tx.exec('INSERT INTO schema_migrations (version) VALUES (?)', [version]);
      });
      console.log(`[Migrator] Applied: ${file}`);
    } catch (err) {
      // ALTER TABLE ADD COLUMN fails if column already exists — treat as idempotent
      if (isDuplicateColumn(err)) {
        console.log(`[Migrator] Skipped (columns already exist): ${file}`);
        await db.exec('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)', [version]);
      } else if (version === '003_deliverables_task_version_unique' &&
                 isUniqueViolation(err)) {
        console.error(`[Migrator] Migration ${file} cannot be applied: existing duplicate (task_id, version) rows in deliverables.`);
        console.error(`[Migrator] Run: SELECT task_id, version, COUNT(*) FROM deliverables WHERE task_id IS NOT NULL GROUP BY task_id, version HAVING COUNT(*) > 1;`);
        console.error(`[Migrator] Resolve duplicates, then restart.`);
        throw err;
      } else {
        console.error(`[Migrator] Failed to apply ${file}:`, err.message);
        throw err;
      }
    }
  }
}
