import { describe, test, expect, jest } from '@jest/globals';
import { createMysqlAdapter, shouldUseTextProtocol } from '../db/mysqlAdapter.js';

describe('mysqlAdapter', () => {
  test('uses text protocol for LIMIT placeholders', async () => {
    const pool = {
      query: jest.fn(async () => [[{ id: 1 }]]),
      execute: jest.fn(async () => { throw new Error('execute should not be used'); }),
      end: jest.fn(async () => {}),
      getConnection: jest.fn()
    };
    const db = createMysqlAdapter(pool);

    const rows = await db.many('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?', [5]);

    expect(rows).toEqual([{ id: 1 }]);
    expect(pool.query).toHaveBeenCalledWith('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?', [5]);
    expect(pool.execute).not.toHaveBeenCalled();
  });

  test('keeps prepared statements for non-LIMIT queries', async () => {
    const pool = {
      query: jest.fn(async () => { throw new Error('query should not be used'); }),
      execute: jest.fn(async () => [[{ id: 2 }]]),
      end: jest.fn(async () => {}),
      getConnection: jest.fn()
    };
    const db = createMysqlAdapter(pool);

    const row = await db.one('SELECT * FROM tasks WHERE id = ?', [2]);

    expect(row).toEqual({ id: 2 });
    expect(pool.execute).toHaveBeenCalledWith('SELECT * FROM tasks WHERE id = ?', [2]);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('detects LIMIT and OFFSET placeholder queries', () => {
    expect(shouldUseTextProtocol('SELECT * FROM tasks LIMIT ?', [10])).toBe(true);
    expect(shouldUseTextProtocol('SELECT * FROM tasks LIMIT ? OFFSET ?', [10, 20])).toBe(true);
    expect(shouldUseTextProtocol('SELECT * FROM tasks WHERE id = ?', [1])).toBe(false);
  });
});
