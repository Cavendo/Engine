import { describe, test, expect } from '@jest/globals';
import { existsSync, readFileSync } from 'fs';

describe('runtime skills migrations', () => {
  test('base and pg migration 006 exist and define runtime tables', () => {
    const basePath = 'server/db/migrations/006_runtime_skills.sql';
    const pgPath = 'server/db/migrations/pg/006_runtime_skills.sql';

    expect(existsSync(basePath)).toBe(true);
    expect(existsSync(pgPath)).toBe(true);

    const base = readFileSync(basePath, 'utf8');
    const pg = readFileSync(pgPath, 'utf8');

    for (const content of [base, pg]) {
      expect(content).toMatch(/CREATE TABLE IF NOT EXISTS skill_invocations/);
      expect(content).toMatch(/CREATE TABLE IF NOT EXISTS skill_invocation_artifacts/);
      expect(content).toMatch(/CREATE TABLE IF NOT EXISTS runtime_skill_policies/);
    }

    expect(base).toMatch(/idx_runtime_skill_policies_unique_ws/);
    expect(base).toMatch(/idx_runtime_skill_policies_unique_global/);
  });
});
