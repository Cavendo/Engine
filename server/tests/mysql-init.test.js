import { describe, test, expect, jest } from '@jest/globals';
import { applyMySqlSchema, splitSqlStatements, coreTableExists } from '../db/init.js';

describe('MySQL schema bootstrap', () => {
  test('splitSqlStatements keeps quoted semicolons intact', () => {
    const statements = splitSqlStatements(`
      CREATE TABLE foo (id INT, note TEXT DEFAULT 'a;b');
      CREATE INDEX idx_foo_id ON foo(id);
    `);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/a;b/);
    expect(statements[1]).toMatch(/CREATE INDEX idx_foo_id/);
  });

  test('applyMySqlSchema skips existing indexes and runs other statements', async () => {
    const run = jest.fn(async () => {});
    const one = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ INDEX_NAME: 'idx_foo_id' });

    await applyMySqlSchema(
      { run, one },
      `
        CREATE TABLE IF NOT EXISTS foo (id BIGINT PRIMARY KEY, name VARCHAR(255));
        CREATE INDEX idx_foo_name ON foo(name);
        CREATE INDEX idx_foo_id ON foo(id);
      `
    );

    expect(one).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('FROM information_schema.statistics'),
      ['foo', 'idx_foo_name']
    );
    expect(one).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FROM information_schema.statistics'),
      ['foo', 'idx_foo_id']
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('CREATE TABLE IF NOT EXISTS foo')
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('CREATE INDEX idx_foo_name ON foo(name)')
    );
  });

  test('coreTableExists checks mysql information_schema', async () => {
    const one = jest.fn(async () => ({ table_name: 'users' }));

    const exists = await coreTableExists({ dialect: 'mysql', one }, 'users');

    expect(exists).toBe(true);
    expect(one).toHaveBeenCalledWith(
      expect.stringContaining('FROM information_schema.tables'),
      ['users']
    );
  });
});
