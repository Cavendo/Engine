import { describe, test, expect } from '@jest/globals';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('external task result completion migrations', () => {
  test('sqlite and postgres migrations allow completed external execution status', () => {
    const basePath = join(__dirname, '../db/migrations/012_external_task_completed_status.sql');
    const pgPath = join(__dirname, '../db/migrations/pg/013_external_task_completed_status.sql');

    expect(existsSync(basePath)).toBe(true);
    expect(existsSync(pgPath)).toBe(true);

    const base = readFileSync(basePath, 'utf8');
    const pg = readFileSync(pgPath, 'utf8');

    for (const content of [base, pg]) {
      expect(content).toMatch(/external_execution_status/);
      expect(content).toMatch(/'completed'/);
    }
  });
});
