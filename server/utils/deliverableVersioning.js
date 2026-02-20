/**
 * Deliverable Versioning Utility
 *
 * Provides retry logic for deliverable inserts that may conflict on
 * the unique (task_id, version) index. All DB work must be synchronous
 * (better-sqlite3 transactions are sync). Async work (file I/O, route
 * dispatch) must happen outside the retry block.
 *
 * Issue #15: Fixes version races across all three creation paths.
 */

const MAX_VERSION_RETRIES = 3;

/**
 * Retry wrapper for deliverable inserts with unique version constraint.
 * buildInsertFn must be sync (DB-only): read MAX(version), INSERT, update parent.
 * Returns the result of buildInsertFn on success.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {() => any} buildInsertFn - Sync closure: version read + INSERT + parent update
 * @returns {any} Result of buildInsertFn
 * @throws {Error} On retry exhaustion or non-unique-constraint errors
 */
export function insertDeliverableWithRetry(db, buildInsertFn) {
  for (let attempt = 1; attempt <= MAX_VERSION_RETRIES; attempt++) {
    try {
      return db.transaction(() => {
        return buildInsertFn();
      })();
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' && attempt < MAX_VERSION_RETRIES) {
        continue; // retry — transaction rolled back, re-read version
      }
      throw err;
    }
  }
}
