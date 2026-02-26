/**
 * SQLite Adapter — wraps better-sqlite3 in the flat async API.
 *
 * API:
 *   await db.one(sql, params?)      → Row | undefined
 *   await db.many(sql, params?)     → Row[]
 *   await db.exec(sql, params?)     → { changes }
 *   await db.insert(sql, params?)   → { lastInsertRowid, changes }
 *   await db.tx(async (tx) => {})   → T
 *   await db.run(sql)               → void  (raw exec, no params — DDL/PRAGMA)
 *   db.close()                      → void
 *   db.dialect                       → 'sqlite'
 *
 * The SQLite adapter resolves all promises synchronously since
 * better-sqlite3 is a synchronous driver. This means async/await
 * at call sites adds zero overhead (microtask only).
 *
 * Transaction strategy: manual BEGIN/COMMIT/ROLLBACK via the
 * underlying connection. Since all awaits inside tx() resolve
 * synchronously, no interleaving occurs on the single connection.
 *
 * STRICT RULE: Only tx.one/many/exec/insert calls are allowed
 * inside tx() callbacks. No external awaits (HTTP, file I/O, timers).
 *
 * Transaction guard: AsyncLocalStorage tracks whether a tx() callback
 * is active. Calling db.one/many/exec/insert inside a tx() callback
 * triggers an error (default) or warning, controlled by TX_GUARD_MODE.
 * Nested db.tx() is explicitly disallowed.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const txStore = new AsyncLocalStorage();
const txGuardMode = process.env.TX_GUARD_MODE || 'error';

/**
 * Guard against calling outer db.method() inside a tx() callback.
 * @param {string} method - Method name for the error message
 */
function guardOuterCall(method) {
  if (txStore.getStore()?.inTx) {
    const msg = `db.${method}() called during active transaction. Use tx.${method}() instead.`;
    if (txGuardMode === 'error') throw new Error(msg);
    console.warn(`[cavendo:tx-guard] ${msg}\n${new Error().stack}`);
  }
}

/**
 * Validate that SQL is a single-row INSERT statement.
 * @param {string} sql
 * @throws {Error} If SQL is not an INSERT or contains multi-row VALUES
 */
function assertSingleInsert(sql) {
  const trimmed = sql.trimStart();
  if (!/^INSERT\b/i.test(trimmed)) {
    throw new Error('db.insert() only accepts INSERT statements');
  }
  // Detect multi-row VALUES: pattern like "), (" after VALUES(...)
  if (/\bVALUES\s*\(.*\)\s*,\s*\(/is.test(sql)) {
    throw new Error('db.insert() only supports single-row INSERT');
  }
}

/**
 * Create a SQLite adapter wrapping a better-sqlite3 Database instance.
 * @param {import('better-sqlite3').Database} raw - better-sqlite3 Database
 * @returns {object} Adapter with one/many/exec/insert/tx/run/close/dialect
 */
export function createSqliteAdapter(raw) {
  const adapter = {
    dialect: 'sqlite',

    /** @type {import('better-sqlite3').Database} */
    _raw: raw,

    /**
     * Fetch a single row.
     * @param {string} sql
     * @param {any[]} [params]
     * @returns {Promise<object|undefined>}
     */
    async one(sql, params) {
      guardOuterCall('one');
      return raw.prepare(sql).get(...(params || []));
    },

    /**
     * Fetch multiple rows.
     * @param {string} sql
     * @param {any[]} [params]
     * @returns {Promise<object[]>}
     */
    async many(sql, params) {
      guardOuterCall('many');
      return raw.prepare(sql).all(...(params || []));
    },

    /**
     * Execute a statement (UPDATE/DELETE/INSERT when ID not needed).
     * @param {string} sql
     * @param {any[]} [params]
     * @returns {Promise<{changes: number}>}
     */
    async exec(sql, params) {
      guardOuterCall('exec');
      const result = raw.prepare(sql).run(...(params || []));
      return { changes: result.changes };
    },

    /**
     * Execute a single-row INSERT and return the AUTOINCREMENT id.
     * Assumes the table has an INTEGER PRIMARY KEY named `id`.
     * Only single-row INSERT statements are accepted.
     * @param {string} sql - Must be an INSERT statement with a single VALUES row
     * @param {any[]} [params]
     * @returns {Promise<{lastInsertRowid: number, changes: number}>}
     * @throws {Error} If sql is not an INSERT or contains multi-row VALUES
     */
    async insert(sql, params) {
      guardOuterCall('insert');
      assertSingleInsert(sql);
      const result = raw.prepare(sql).run(...(params || []));
      return {
        lastInsertRowid: Number(result.lastInsertRowid),
        changes: result.changes
      };
    },

    /**
     * Run a transaction. The callback receives a tx object with the same
     * one/many/exec/insert API. Only tx.* calls are allowed inside — no
     * external awaits.
     *
     * Calling db.one/many/exec/insert inside the callback triggers a
     * guard error (or warning if TX_GUARD_MODE=warn). Nested db.tx()
     * is explicitly disallowed.
     *
     * @template T
     * @param {(tx: object) => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async tx(fn) {
      if (txStore.getStore()?.inTx) {
        throw new Error('Nested transactions are not supported. Use the existing tx object.');
      }
      return txStore.run({ inTx: true }, async () => {
        raw.exec('BEGIN');
        try {
          const tx = createTxProxy(raw);
          const result = await fn(tx);
          raw.exec('COMMIT');
          return result;
        } catch (err) {
          raw.exec('ROLLBACK');
          throw err;
        }
      });
    },

    /**
     * Execute raw SQL without params (for DDL, PRAGMA, multi-statement scripts).
     * @param {string} sql
     * @returns {Promise<void>}
     */
    async run(sql) {
      raw.exec(sql);
    },

    /**
     * Close the database connection.
     */
    close() {
      raw.close();
    }
  };

  return adapter;
}

/**
 * Create a transaction proxy with one/many/exec/insert methods
 * that operate on the same connection within the active transaction.
 * @param {import('better-sqlite3').Database} raw
 * @returns {object}
 */
function createTxProxy(raw) {
  return {
    dialect: 'sqlite',

    async one(sql, params) {
      return raw.prepare(sql).get(...(params || []));
    },

    async many(sql, params) {
      return raw.prepare(sql).all(...(params || []));
    },

    async exec(sql, params) {
      const result = raw.prepare(sql).run(...(params || []));
      return { changes: result.changes };
    },

    async insert(sql, params) {
      assertSingleInsert(sql);
      const result = raw.prepare(sql).run(...(params || []));
      return {
        lastInsertRowid: Number(result.lastInsertRowid),
        changes: result.changes
      };
    },

    async run(sql) {
      raw.exec(sql);
    }
  };
}
