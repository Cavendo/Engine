import db from '../db/adapter.js';
import { safeJsonParse } from '../utils/routeHelpers.js';

const DEFAULT_CONTEXT_LIMIT = 50;
const DEFAULT_SCAN_LIMIT = 200;
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
  'has', 'have', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the',
  'this', 'to', 'was', 'were', 'with'
]);

export function normalizeSearchTerms(value, maxTerms = 12) {
  const seen = new Set();
  const terms = [];
  const limit = Math.max(1, Number(maxTerms) || 12);

  for (const rawTerm of String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, ' ').split(/\s+/)) {
    const term = rawTerm.replace(/^[-_]+|[-_]+$/g, '');
    if (term.length < 2 || STOP_WORDS.has(term) || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= limit) break;
  }

  return terms;
}

export function buildSafeFullTextQuery(value, maxTerms = 12) {
  const stripped = String(value || '')
    .replace(/[&|!():*']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalizeSearchTerms(stripped, maxTerms).join(' ');
}

function normalizeKnowledgeRow(row) {
  return {
    ...row,
    tags: safeJsonParse(row?.tags, [])
  };
}

function collectTaskSearchText(task) {
  const parts = [
    task?.title,
    task?.description,
    task?.tags
  ];

  const context = safeJsonParse(task?.context, {});
  if (context && typeof context === 'object') {
    parts.push(context.summary, context.notes, context.objective, context.instructions);
  } else {
    parts.push(context);
  }

  return parts
    .filter((part) => part !== null && part !== undefined)
    .map((part) => typeof part === 'string' ? part : JSON.stringify(part))
    .join(' ');
}

function makeAudit(mode, safeQueryText, fallbackReason = null) {
  return {
    mode,
    safeQueryText,
    fallbackReason
  };
}

function scoreKnowledgeRow(row, terms) {
  const title = String(row.title || '').toLowerCase();
  const category = String(row.category || '').toLowerCase();
  const tags = String(row.tags || '').toLowerCase();
  const content = String(row.content || '').toLowerCase();

  return terms.reduce((score, term) => {
    let nextScore = score;
    if (title.includes(term)) nextScore += 5;
    if (category.includes(term)) nextScore += 3;
    if (tags.includes(term)) nextScore += 2;
    if (content.includes(term)) nextScore += 1;
    return nextScore;
  }, 0);
}

async function retrieveRecentRows(database, projectId, limit) {
  return await database.many(`
    SELECT id, title, content, content_type, category, tags
    FROM knowledge
    WHERE project_id = ?
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ?
  `, [projectId, limit]);
}

export async function retrieveRecentKnowledgeForTask(task, options = {}) {
  if (!task?.project_id) return [];
  const database = options.database || db;
  const limit = Math.max(1, Number(options.limit) || DEFAULT_CONTEXT_LIMIT);
  const rows = await retrieveRecentRows(database, task.project_id, limit);
  return rows.map(normalizeKnowledgeRow);
}

async function retrievePortableWeightedKnowledge(database, task, safeQueryText, limit) {
  const scanLimit = Math.max(limit, Number(limit) * 4, DEFAULT_SCAN_LIMIT);
  const rows = await retrieveRecentRows(database, task.project_id, scanLimit);
  const terms = safeQueryText.split(/\s+/).filter(Boolean);

  return rows
    .map((row, index) => ({ row, index, score: scoreKnowledgeRow(row, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => normalizeKnowledgeRow(entry.row));
}

async function retrievePostgresWeightedKnowledge(database, task, safeQueryText, limit) {
  const weightedVector = `
    setweight(to_tsvector('simple', COALESCE(title, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(category, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(tags, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(content, '')), 'C')
  `;

  const rows = await database.many(`
    SELECT id, title, content, content_type, category, tags,
      ts_rank_cd((${weightedVector}), websearch_to_tsquery('simple', ?)) AS rank
    FROM knowledge
    WHERE project_id = ?
      AND (${weightedVector}) @@ websearch_to_tsquery('simple', ?)
    ORDER BY rank DESC, updated_at DESC, created_at DESC
    LIMIT ?
  `, [safeQueryText, task.project_id, safeQueryText, limit]);

  return rows.map(normalizeKnowledgeRow);
}

async function retrieveFallback(task, options, safeQueryText, fallbackReason) {
  try {
    const chunks = await retrieveRecentKnowledgeForTask(task, options);
    return {
      chunks,
      audit: makeAudit('recency_fallback', safeQueryText, fallbackReason)
    };
  } catch (err) {
    options.logger?.warn?.('[TaskContextRetrieval] Recent context fallback failed:', err?.message || err);
    return {
      chunks: [],
      audit: makeAudit('recency_fallback', safeQueryText, 'recent_query_error')
    };
  }
}

export async function retrieveWeightedKnowledgeForTask(task, options = {}) {
  const database = options.database || db;
  const limit = Math.max(1, Number(options.limit) || DEFAULT_CONTEXT_LIMIT);
  const safeQueryText = buildSafeFullTextQuery(collectTaskSearchText(task));
  const fallbackOptions = { ...options, database, limit };

  if (!task?.project_id) {
    return {
      chunks: [],
      audit: makeAudit('recency_fallback', safeQueryText, 'missing_project')
    };
  }

  if (!safeQueryText) {
    return await retrieveFallback(task, fallbackOptions, safeQueryText, 'empty_safe_query');
  }

  try {
    const chunks = database.dialect === 'postgres'
      ? await retrievePostgresWeightedKnowledge(database, task, safeQueryText, limit)
      : await retrievePortableWeightedKnowledge(database, task, safeQueryText, limit);

    if (chunks.length === 0) {
      return await retrieveFallback(task, fallbackOptions, safeQueryText, 'no_weighted_matches');
    }

    return {
      chunks,
      audit: makeAudit('weighted_retrieval', safeQueryText)
    };
  } catch (err) {
    options.logger?.warn?.('[TaskContextRetrieval] Weighted retrieval failed; using recent context:', err?.message || err);
    return await retrieveFallback(task, fallbackOptions, safeQueryText, 'fts_error');
  }
}
