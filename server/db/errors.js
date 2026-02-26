/**
 * Cross-dialect database error helpers.
 *
 * Provides portable error detection that works with both
 * better-sqlite3 and pg error objects.
 */

/**
 * Check if an error is a unique constraint violation.
 * Works with both SQLite (better-sqlite3) and PostgreSQL (pg) errors.
 *
 * @param {Error} err - The error to check
 * @returns {boolean} True if this is a unique constraint violation
 */
export function isUniqueViolation(err) {
  if (!err) return false;

  // SQLite: better-sqlite3 sets err.code
  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return true;

  // PostgreSQL: pg sets err.code to SQLSTATE '23505' (unique_violation)
  if (err.code === '23505') return true;

  // Fallback: check error message patterns
  if (typeof err.message === 'string') {
    if (err.message.includes('UNIQUE constraint failed')) return true;
    if (err.message.includes('duplicate key value violates unique constraint')) return true;
  }

  return false;
}

/**
 * Check if an error is a foreign key constraint violation.
 * @param {Error} err
 * @returns {boolean}
 */
export function isForeignKeyViolation(err) {
  if (!err) return false;

  // SQLite
  if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return true;

  // PostgreSQL: SQLSTATE 23503
  if (err.code === '23503') return true;

  return false;
}

/**
 * Check if an error indicates a "duplicate column" during ALTER TABLE.
 * Used by the migrator to treat ADD COLUMN as idempotent.
 * @param {Error} err
 * @returns {boolean}
 */
export function isDuplicateColumn(err) {
  if (!err || typeof err.message !== 'string') return false;

  // SQLite
  if (err.message.includes('duplicate column name')) return true;

  // PostgreSQL
  if (err.message.includes('already exists')) return true;

  return false;
}
