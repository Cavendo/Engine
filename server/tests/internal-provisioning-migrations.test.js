import { describe, test, expect } from '@jest/globals';
import { existsSync, readFileSync } from 'fs';

describe('internal provisioning migrations', () => {
  test('base, pg, and mysql migration 007 exist and define projects external_key support', () => {
    const basePath = 'server/db/migrations/007_projects_external_key.sql';
    const pgPath = 'server/db/migrations/pg/007_projects_external_key.sql';
    const mysqlPath = 'server/db/migrations/mysql/007_projects_external_key.sql';

    expect(existsSync(basePath)).toBe(true);
    expect(existsSync(pgPath)).toBe(true);
    expect(existsSync(mysqlPath)).toBe(true);

    const base = readFileSync(basePath, 'utf8');
    const pg = readFileSync(pgPath, 'utf8');
    const mysql = readFileSync(mysqlPath, 'utf8');

    expect(base).toMatch(/ALTER TABLE projects ADD COLUMN external_key TEXT/);
    expect(base).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_external_key/);
    expect(pg).toMatch(/ALTER TABLE projects ADD COLUMN IF NOT EXISTS external_key TEXT/);
    expect(pg).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_external_key/);
    expect(mysql).toMatch(/ALTER TABLE projects ADD COLUMN external_key VARCHAR\(200\) NULL/);
    expect(mysql).toMatch(/CREATE UNIQUE INDEX idx_projects_external_key ON projects\(external_key\)/);
  });
});
