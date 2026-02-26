/**
 * Deliverable Versioning Utility
 *
 * Provides retry logic for deliverable inserts that may conflict on
 * the unique (task_id, version) index. Uses the database adapter's
 * transaction API. Async work (file I/O, route dispatch) must happen
 * outside the retry block.
 *
 * Issue #15: Fixes version races across all three creation paths.
 */

import { isUniqueViolation } from '../db/errors.js';

const MAX_VERSION_RETRIES = 3;

/**
 * Retry wrapper for deliverable inserts with unique version constraint.
 * buildInsertFn receives a transaction handle (tx) and must perform all
 * DB work through it: read MAX(version), INSERT, update parent.
 * Returns the result of buildInsertFn on success.
 *
 * @param {object} db - Database adapter instance
 * @param {(tx: object) => Promise<any>} buildInsertFn - Async closure: version read + INSERT + parent update
 * @returns {Promise<any>} Result of buildInsertFn
 * @throws {Error} On retry exhaustion or non-unique-constraint errors
 */
export async function insertDeliverableWithRetry(db, buildInsertFn) {
  for (let attempt = 1; attempt <= MAX_VERSION_RETRIES; attempt++) {
    try {
      return await db.tx(async (tx) => {
        return await buildInsertFn(tx);
      });
    } catch (err) {
      if (isUniqueViolation(err) && attempt < MAX_VERSION_RETRIES) {
        continue; // retry — transaction rolled back, re-read version
      }
      throw err;
    }
  }
}
