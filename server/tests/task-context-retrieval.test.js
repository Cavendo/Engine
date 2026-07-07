import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import crypto from 'crypto';

const tempDir = mkdtempSync(join(tmpdir(), 'cavendo-task-context-retrieval-'));
const tempDbPath = join(tempDir, 'test.db');
process.env.DATABASE_PATH = tempDbPath;
process.env.DB_DRIVER = 'sqlite';
process.env.SESSION_SECRET = 'test-secret-for-task-context-retrieval';
process.env.NODE_ENV = 'test';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const { initializeDatabase } = await import('../db/init.js');
const { runMigrations } = await import('../db/migrator.js');
const {
  buildSafeFullTextQuery,
  retrieveWeightedKnowledgeForTask
} = await import('../services/taskContextRetrieval.js');
const { default: db } = await import('../db/adapter.js');

beforeAll(async () => {
  await initializeDatabase(db);
  await runMigrations(db);
});

afterEach(async () => {
  await db.exec('DELETE FROM knowledge', []);
  await db.exec('DELETE FROM tasks', []);
  await db.exec('DELETE FROM projects', []);
});

afterAll(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

async function createProject(name = 'Retrieval Project') {
  const result = await db.insert(`
    INSERT INTO projects (name, description)
    VALUES (?, 'Retrieval fixture')
  `, [name]);
  return result.lastInsertRowid;
}

async function insertKnowledge(projectId, title, content, createdAt) {
  await db.insert(`
    INSERT INTO knowledge (project_id, title, content, content_type, category, tags, created_at, updated_at)
    VALUES (?, ?, ?, 'markdown', 'guide', '["retrieval"]', ?, ?)
  `, [projectId, title, content, createdAt, createdAt]);
}

describe('task context retrieval', () => {
  test('sanitizes full-text operator characters and caps significant terms', () => {
    const query = buildSafeFullTextQuery(
      "alpha & beta | gamma ! delta (epsilon) zeta: eta* 'theta' iota kappa lambda mu nu xi omicron"
    );

    expect(query).toBe('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu');
    expect(query).not.toMatch(/[&|!():*']/);
    expect(query.split(/\s+/)).toHaveLength(12);
  });

  test('uses recent context fallback when safe query is empty', async () => {
    const projectId = await createProject();
    await insertKnowledge(projectId, 'Old Note', 'Older context', '2026-01-01 00:00:00');
    await insertKnowledge(projectId, 'Recent Note', 'Recent context', '2026-02-01 00:00:00');

    const result = await retrieveWeightedKnowledgeForTask({
      id: 1,
      project_id: projectId,
      title: "& | ! ( ) : * '",
      description: ''
    });

    expect(result.audit).toEqual({
      mode: 'recency_fallback',
      safeQueryText: '',
      fallbackReason: 'empty_safe_query'
    });
    expect(result.chunks.map((chunk) => chunk.title)).toEqual(['Recent Note', 'Old Note']);
  });

  test('falls back to recent context when Postgres full-text retrieval throws', async () => {
    const fallbackRows = [{
      id: 9,
      title: 'Recent Safe Context',
      content: 'Fallback content',
      content_type: 'markdown',
      category: 'guide',
      tags: '["safe"]'
    }];
    const mockDatabase = {
      dialect: 'postgres',
      many: jest.fn(async (sql, params) => {
        if (sql.includes('websearch_to_tsquery')) {
          expect(params[0]).toBe('alpha beta');
          throw new Error('syntax error in tsquery');
        }
        return fallbackRows;
      })
    };
    const logger = { warn: jest.fn() };

    const result = await retrieveWeightedKnowledgeForTask({
      id: 2,
      project_id: 42,
      title: 'alpha beta'
    }, {
      database: mockDatabase,
      logger,
      limit: 5
    });

    expect(mockDatabase.many).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      '[TaskContextRetrieval] Weighted retrieval failed; using recent context:',
      'syntax error in tsquery'
    );
    expect(result.audit).toEqual({
      mode: 'recency_fallback',
      safeQueryText: 'alpha beta',
      fallbackReason: 'fts_error'
    });
    expect(result.chunks).toEqual([{
      ...fallbackRows[0],
      tags: ['safe']
    }]);
  });
});
