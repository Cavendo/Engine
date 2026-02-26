/**
 * Tests for the database adapter layer (Phase 1).
 *
 * Covers:
 * - sqlRewriter: placeholder rewriting, datetime('now'), INSERT OR IGNORE
 * - sqliteAdapter: one/many/exec/insert/tx/run/close against in-memory DB
 * - errors: isUniqueViolation, isForeignKeyViolation, isDuplicateColumn
 */

import { jest } from '@jest/globals';
import Database from 'better-sqlite3';

// ============================================
// SQL Rewriter Tests
// ============================================

const { rewriteSQL, rewritePlaceholders } = await import('../db/sqlRewriter.js');

describe('sqlRewriter', () => {
  describe('rewritePlaceholders', () => {
    test('rewrites simple ? to $1, $2', () => {
      expect(rewritePlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'))
        .toBe('SELECT * FROM t WHERE a = $1 AND b = $2');
    });

    test('handles no placeholders', () => {
      const sql = 'SELECT * FROM tasks';
      expect(rewritePlaceholders(sql)).toBe(sql);
    });

    test('skips ? inside single-quoted strings', () => {
      expect(rewritePlaceholders("SELECT * FROM t WHERE a = ? AND b = '?'"))
        .toBe("SELECT * FROM t WHERE a = $1 AND b = '?'");
    });

    test('handles escaped quotes inside strings', () => {
      expect(rewritePlaceholders("SELECT * FROM t WHERE a = ? AND b = 'it''s a ? test'"))
        .toBe("SELECT * FROM t WHERE a = $1 AND b = 'it''s a ? test'");
    });

    test('handles multiple placeholders in INSERT', () => {
      expect(rewritePlaceholders('INSERT INTO t (a, b, c) VALUES (?, ?, ?)'))
        .toBe('INSERT INTO t (a, b, c) VALUES ($1, $2, $3)');
    });

    test('handles IN clause with multiple placeholders', () => {
      expect(rewritePlaceholders('SELECT * FROM t WHERE id IN (?, ?, ?)'))
        .toBe('SELECT * FROM t WHERE id IN ($1, $2, $3)');
    });

    test('skips ? inside double-quoted identifiers', () => {
      expect(rewritePlaceholders('SELECT "what?" FROM t WHERE a = ?'))
        .toBe('SELECT "what?" FROM t WHERE a = $1');
    });

    test('handles escaped double quotes inside identifiers', () => {
      expect(rewritePlaceholders('SELECT "col""?" FROM t WHERE a = ?'))
        .toBe('SELECT "col""?" FROM t WHERE a = $1');
    });

    test('skips ? inside single-line comments', () => {
      expect(rewritePlaceholders('SELECT * FROM t -- where is ?\nWHERE a = ?'))
        .toBe('SELECT * FROM t -- where is ?\nWHERE a = $1');
    });

    test('skips ? inside block comments', () => {
      expect(rewritePlaceholders('SELECT * FROM t /* ? placeholder */ WHERE a = ?'))
        .toBe('SELECT * FROM t /* ? placeholder */ WHERE a = $1');
    });

    test('handles unterminated block comment gracefully', () => {
      // Unterminated block comment — ? stays unrewritten since parser is in comment state
      expect(rewritePlaceholders('SELECT * FROM t /* ? forever'))
        .toBe('SELECT * FROM t /* ? forever');
    });

    test('handles single-line comment at end with no newline', () => {
      expect(rewritePlaceholders('SELECT ? -- trailing ?'))
        .toBe('SELECT $1 -- trailing ?');
    });

    test('handles mixed: strings + identifiers + comments + placeholders', () => {
      const sql = `SELECT "col?" FROM t -- comment ?
WHERE a = ? AND b = '?' /* block ? */ AND c = ?`;
      const expected = `SELECT "col?" FROM t -- comment ?
WHERE a = $1 AND b = '?' /* block ? */ AND c = $2`;
      expect(rewritePlaceholders(sql)).toBe(expected);
    });

    test('throws clear error for ?| operator', () => {
      expect(() => rewritePlaceholders("SELECT * FROM t WHERE data ?| array['a']"))
        .toThrow('SQL contains PostgreSQL JSON operator (?|)');
    });

    test('throws clear error for ?& operator', () => {
      expect(() => rewritePlaceholders("SELECT * FROM t WHERE data ?& array['a']"))
        .toThrow('SQL contains PostgreSQL JSON operator (?&)');
    });

    test('?| inside string literal does NOT throw', () => {
      expect(rewritePlaceholders("SELECT * FROM t WHERE a = '?|' AND b = ?"))
        .toBe("SELECT * FROM t WHERE a = '?|' AND b = $1");
    });
  });

  describe('rewriteSQL (full pipeline)', () => {
    test("rewrites datetime('now') to NOW()", () => {
      expect(rewriteSQL("SELECT * FROM t WHERE created_at > datetime('now')"))
        .toBe('SELECT * FROM t WHERE created_at > NOW()');
    });

    test("rewrites datetime('now') in DEFAULT clauses", () => {
      expect(rewriteSQL("INSERT INTO t (a, created_at) VALUES (?, datetime('now'))"))
        .toBe('INSERT INTO t (a, created_at) VALUES ($1, NOW())');
    });

    test("rewrites datetime('now', '-7 days') to interval subtraction", () => {
      expect(rewriteSQL("SELECT * FROM t WHERE updated_at >= datetime('now', '-7 days')"))
        .toBe("SELECT * FROM t WHERE updated_at >= (NOW() - INTERVAL '7 days')");
    });

    test("rewrites datetime('now', '-1 hour') to interval subtraction", () => {
      expect(rewriteSQL("SELECT * FROM t WHERE created_at >= datetime('now', '-1 hour')"))
        .toBe("SELECT * FROM t WHERE created_at >= (NOW() - INTERVAL '1 hour')");
    });

    test("rewrites datetime('now', '-24 hours') to interval subtraction", () => {
      expect(rewriteSQL("SELECT * FROM t WHERE created_at >= datetime('now', '-24 hours')"))
        .toBe("SELECT * FROM t WHERE created_at >= (NOW() - INTERVAL '24 hours')");
    });

    test("rewrites datetime('now', '+3 days') to interval addition", () => {
      expect(rewriteSQL("SELECT * FROM t WHERE due_date <= datetime('now', '+3 days')"))
        .toBe("SELECT * FROM t WHERE due_date <= (NOW() + INTERVAL '3 days')");
    });

    test("handles mixed: modifier + bare datetime in same SQL", () => {
      const sql = "SELECT * FROM t WHERE created_at > datetime('now', '-7 days') AND updated_at < datetime('now')";
      const expected = "SELECT * FROM t WHERE created_at > (NOW() - INTERVAL '7 days') AND updated_at < NOW()";
      expect(rewriteSQL(sql)).toBe(expected);
    });

    test("handles string-interpolated days value in datetime modifier", () => {
      const days = 30;
      const sql = `SELECT * FROM t WHERE updated_at >= datetime('now', '-${days} days')`;
      expect(rewriteSQL(sql))
        .toBe("SELECT * FROM t WHERE updated_at >= (NOW() - INTERVAL '30 days')");
    });

    test('rewrites INSERT OR IGNORE to ON CONFLICT DO NOTHING', () => {
      const result = rewriteSQL('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)');
      expect(result).toContain('INSERT');
      expect(result).not.toContain('OR IGNORE');
      expect(result).toContain('ON CONFLICT DO NOTHING');
      expect(result).toContain('$1');
    });

    test('combined: placeholder + datetime + INSERT OR IGNORE', () => {
      const sql = "INSERT OR IGNORE INTO t (a, created_at) VALUES (?, datetime('now'))";
      const result = rewriteSQL(sql);
      expect(result).toContain('$1');
      expect(result).toContain('NOW()');
      expect(result).toContain('ON CONFLICT DO NOTHING');
      expect(result).not.toContain('OR IGNORE');
      expect(result).not.toContain("datetime('now')");
    });

    test('leaves normal INSERT alone (no ON CONFLICT added)', () => {
      const result = rewriteSQL('INSERT INTO t (a) VALUES (?)');
      expect(result).toBe('INSERT INTO t (a) VALUES ($1)');
      expect(result).not.toContain('ON CONFLICT');
    });

    test('passes through plain SELECT unchanged (except placeholders)', () => {
      const result = rewriteSQL('SELECT id, name FROM tasks WHERE status = ?');
      expect(result).toBe('SELECT id, name FROM tasks WHERE status = $1');
    });
  });
});

// ============================================
// Error Helpers Tests
// ============================================

const { isUniqueViolation, isForeignKeyViolation, isDuplicateColumn } = await import('../db/errors.js');

describe('error helpers', () => {
  describe('isUniqueViolation', () => {
    test('detects SQLite SQLITE_CONSTRAINT_UNIQUE', () => {
      const err = new Error('UNIQUE constraint failed');
      err.code = 'SQLITE_CONSTRAINT_UNIQUE';
      expect(isUniqueViolation(err)).toBe(true);
    });

    test('detects PostgreSQL 23505', () => {
      const err = new Error('duplicate key value violates unique constraint');
      err.code = '23505';
      expect(isUniqueViolation(err)).toBe(true);
    });

    test('fallback: detects by message (SQLite)', () => {
      const err = new Error('UNIQUE constraint failed: tasks.id');
      expect(isUniqueViolation(err)).toBe(true);
    });

    test('fallback: detects by message (PG)', () => {
      const err = new Error('duplicate key value violates unique constraint "tasks_pkey"');
      expect(isUniqueViolation(err)).toBe(true);
    });

    test('returns false for unrelated error', () => {
      expect(isUniqueViolation(new Error('table not found'))).toBe(false);
    });

    test('returns false for null/undefined', () => {
      expect(isUniqueViolation(null)).toBe(false);
      expect(isUniqueViolation(undefined)).toBe(false);
    });
  });

  describe('isForeignKeyViolation', () => {
    test('detects SQLite FK violation', () => {
      const err = new Error('FOREIGN KEY constraint failed');
      err.code = 'SQLITE_CONSTRAINT_FOREIGNKEY';
      expect(isForeignKeyViolation(err)).toBe(true);
    });

    test('detects PostgreSQL FK violation', () => {
      const err = new Error('violates foreign key constraint');
      err.code = '23503';
      expect(isForeignKeyViolation(err)).toBe(true);
    });

    test('returns false for unrelated error', () => {
      expect(isForeignKeyViolation(new Error('syntax error'))).toBe(false);
    });
  });

  describe('isDuplicateColumn', () => {
    test('detects SQLite duplicate column', () => {
      expect(isDuplicateColumn(new Error('duplicate column name: foo'))).toBe(true);
    });

    test('detects PostgreSQL column already exists', () => {
      expect(isDuplicateColumn(new Error('column "foo" of relation "bar" already exists'))).toBe(true);
    });

    test('returns false for null', () => {
      expect(isDuplicateColumn(null)).toBe(false);
    });
  });
});

// ============================================
// SQLite Adapter Tests
// ============================================

const { createSqliteAdapter } = await import('../db/sqliteAdapter.js');

describe('sqliteAdapter', () => {
  let raw;
  let db;

  beforeAll(() => {
    raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    raw.exec(`
      CREATE TABLE items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        value INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE children (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL REFERENCES items(id),
        label TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_items_name ON items(name);
    `);
    db = createSqliteAdapter(raw);
  });

  afterAll(() => {
    db.close();
  });

  test('has dialect = sqlite', () => {
    expect(db.dialect).toBe('sqlite');
  });

  test('insert() returns lastInsertRowid and changes', async () => {
    const result = await db.insert('INSERT INTO items (name, value) VALUES (?, ?)', ['alpha', 10]);
    expect(result.lastInsertRowid).toBe(1);
    expect(result.changes).toBe(1);
  });

  test('one() returns a single row', async () => {
    const row = await db.one('SELECT * FROM items WHERE id = ?', [1]);
    expect(row).toBeDefined();
    expect(row.name).toBe('alpha');
    expect(row.value).toBe(10);
  });

  test('one() returns undefined for no match', async () => {
    const row = await db.one('SELECT * FROM items WHERE id = ?', [999]);
    expect(row).toBeUndefined();
  });

  test('many() returns array of rows', async () => {
    await db.insert('INSERT INTO items (name, value) VALUES (?, ?)', ['beta', 20]);
    await db.insert('INSERT INTO items (name, value) VALUES (?, ?)', ['gamma', 30]);
    const rows = await db.many('SELECT * FROM items ORDER BY id');
    expect(rows.length).toBe(3);
    expect(rows[0].name).toBe('alpha');
    expect(rows[2].name).toBe('gamma');
  });

  test('many() returns empty array for no matches', async () => {
    const rows = await db.many('SELECT * FROM items WHERE value > ?', [9999]);
    expect(rows).toEqual([]);
  });

  test('exec() returns changes count', async () => {
    const result = await db.exec('UPDATE items SET value = ? WHERE name = ?', [15, 'alpha']);
    expect(result.changes).toBe(1);
  });

  test('exec() returns 0 changes for no match', async () => {
    const result = await db.exec('UPDATE items SET value = ? WHERE name = ?', [0, 'nonexistent']);
    expect(result.changes).toBe(0);
  });

  test('run() executes raw SQL (DDL)', async () => {
    await db.run('CREATE TABLE IF NOT EXISTS temp_test (id INTEGER PRIMARY KEY)');
    // Should not throw
    const row = await db.one("SELECT name FROM sqlite_master WHERE type='table' AND name='temp_test'");
    expect(row).toBeDefined();
    await db.run('DROP TABLE temp_test');
  });

  test('tx() commits on success', async () => {
    await db.tx(async (tx) => {
      await tx.exec('UPDATE items SET value = ? WHERE name = ?', [100, 'alpha']);
      await tx.exec('UPDATE items SET value = ? WHERE name = ?', [200, 'beta']);
    });

    const alpha = await db.one('SELECT value FROM items WHERE name = ?', ['alpha']);
    const beta = await db.one('SELECT value FROM items WHERE name = ?', ['beta']);
    expect(alpha.value).toBe(100);
    expect(beta.value).toBe(200);
  });

  test('tx() rolls back on error', async () => {
    // Set known state
    await db.exec('UPDATE items SET value = ? WHERE name = ?', [50, 'alpha']);

    try {
      await db.tx(async (tx) => {
        await tx.exec('UPDATE items SET value = ? WHERE name = ?', [999, 'alpha']);
        throw new Error('deliberate rollback');
      });
    } catch (err) {
      expect(err.message).toBe('deliberate rollback');
    }

    const row = await db.one('SELECT value FROM items WHERE name = ?', ['alpha']);
    expect(row.value).toBe(50); // rolled back
  });

  test('tx() insert returns lastInsertRowid', async () => {
    const result = await db.tx(async (tx) => {
      return await tx.insert('INSERT INTO items (name, value) VALUES (?, ?)', ['delta', 40]);
    });
    expect(result.lastInsertRowid).toBeGreaterThan(0);
    expect(result.changes).toBe(1);
  });

  test('tx() one/many work inside transaction', async () => {
    await db.tx(async (tx) => {
      await tx.insert('INSERT INTO items (name, value) VALUES (?, ?)', ['epsilon', 50]);
      const row = await tx.one('SELECT * FROM items WHERE name = ?', ['epsilon']);
      expect(row).toBeDefined();
      expect(row.value).toBe(50);

      const rows = await tx.many('SELECT * FROM items WHERE value >= ?', [50]);
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });
  });

  test('insert() unique violation throws', async () => {
    let threw = false;
    try {
      await db.insert('INSERT INTO items (name, value) VALUES (?, ?)', ['alpha', 0]);
    } catch (err) {
      threw = true;
      expect(err.message).toMatch(/UNIQUE constraint failed/);
    }
    expect(threw).toBe(true);
  });

  test('lastInsertRowid is a Number (not BigInt)', async () => {
    const result = await db.insert('INSERT INTO items (name, value) VALUES (?, ?)', ['numbig', 1]);
    expect(typeof result.lastInsertRowid).toBe('number');
  });

  test('_raw exposes the underlying better-sqlite3 instance', () => {
    expect(db._raw).toBe(raw);
  });

  describe('insert() assertions', () => {
    test('rejects non-INSERT SQL (UPDATE)', async () => {
      await expect(db.insert('UPDATE items SET value = 1 WHERE id = 1'))
        .rejects.toThrow('db.insert() only accepts INSERT statements');
    });

    test('rejects non-INSERT SQL (SELECT)', async () => {
      await expect(db.insert('SELECT * FROM items'))
        .rejects.toThrow('db.insert() only accepts INSERT statements');
    });

    test('rejects multi-row VALUES', async () => {
      await expect(db.insert("INSERT INTO items (name, value) VALUES ('a', 1), ('b', 2)"))
        .rejects.toThrow('db.insert() only supports single-row INSERT');
    });

    test('accepts valid single-row INSERT', async () => {
      const result = await db.insert('INSERT INTO items (name, value) VALUES (?, ?)', ['insert_assert', 99]);
      expect(result.lastInsertRowid).toBeGreaterThan(0);
      expect(result.changes).toBe(1);
    });
  });

  describe('tx() outer-call guard', () => {
    test('db.one() inside tx() throws with descriptive message', async () => {
      await expect(db.tx(async () => {
        await db.one('SELECT 1');
      })).rejects.toThrow('db.one() called during active transaction. Use tx.one() instead.');
    });

    test('db.exec() inside tx() throws', async () => {
      await expect(db.tx(async () => {
        await db.exec('UPDATE items SET value = 0 WHERE id = 1');
      })).rejects.toThrow('db.exec() called during active transaction. Use tx.exec() instead.');
    });

    test('db.insert() inside tx() throws', async () => {
      await expect(db.tx(async () => {
        await db.insert("INSERT INTO items (name, value) VALUES ('guard_test', 1)");
      })).rejects.toThrow('db.insert() called during active transaction. Use tx.insert() instead.');
    });

    test('db.one() after tx() completes works normally', async () => {
      await db.tx(async (tx) => {
        await tx.exec('UPDATE items SET value = 77 WHERE name = ?', ['alpha']);
      });
      const row = await db.one('SELECT value FROM items WHERE name = ?', ['alpha']);
      expect(row.value).toBe(77);
    });

    test('tx.one() inside tx() works normally', async () => {
      await db.tx(async (tx) => {
        const row = await tx.one('SELECT * FROM items WHERE name = ?', ['alpha']);
        expect(row).toBeDefined();
      });
    });

    test('nested db.tx() throws', async () => {
      await expect(db.tx(async () => {
        await db.tx(async () => {});
      })).rejects.toThrow('Nested transactions are not supported. Use the existing tx object.');
    });
  });
});
