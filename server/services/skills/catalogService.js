import db from '../../db/adapter.js';
import { SKILLS_ERROR_CODES } from './types.js';
import { getSkillsAdapter } from './adapters/httpWorkerAdapter.js';

function createError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function parseWorkspaceId(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function policyPrecedenceScore(row, skillKey, workspaceId) {
  const ws = parseWorkspaceId(workspaceId);
  const exactSkill = row.skill_key === skillKey;
  const exactWorkspace = row.workspace_id !== null && row.workspace_id !== undefined && Number(row.workspace_id) === ws;
  if (exactSkill && exactWorkspace) return 1;
  if (exactSkill && row.workspace_id === null) return 2;
  if (row.skill_key === '*' && exactWorkspace) return 3;
  if (row.skill_key === '*' && row.workspace_id === null) return 4;
  return 99;
}

export function selectPolicyByPrecedence(rows, skillKey, workspaceId) {
  const sorted = [...rows].sort((a, b) => policyPrecedenceScore(a, skillKey, workspaceId) - policyPrecedenceScore(b, skillKey, workspaceId));
  return sorted[0] || null;
}

export function getEffectiveRole(auth, user) {
  if (auth?.type === 'internal') return 'admin';
  return user?.role || 'viewer';
}

export async function resolvePolicy(skillKey, role, workspaceId) {
  const ws = parseWorkspaceId(workspaceId);
  const rows = await db.many(`
    SELECT skill_key, role, workspace_id, allow_catalog, allow_invoke
    FROM runtime_skill_policies
    WHERE role = ?
      AND (skill_key = ? OR skill_key = '*')
      AND (workspace_id = ? OR workspace_id IS NULL)
  `, [role, skillKey, ws]);

  return selectPolicyByPrecedence(rows, skillKey, ws);
}

export async function assertInvokeAllowed(skillKey, role, workspaceId) {
  const policy = await resolvePolicy(skillKey, role, workspaceId);
  if (!policy || !policy.allow_invoke) {
    throw createError(SKILLS_ERROR_CODES.POLICY_DENIED, 'Runtime skill invocation is not allowed by policy');
  }
  return policy;
}

export async function listCatalogForActor({ auth, user, workspaceId = null }) {
  const adapter = getSkillsAdapter();
  const role = getEffectiveRole(auth, user);
  const catalog = await adapter.listSkills();

  const filtered = [];
  for (const skill of catalog.skills) {
    const policy = await resolvePolicy(skill.key, role, workspaceId);
    if (policy && policy.allow_catalog) {
      filtered.push(skill);
    }
  }

  return {
    provider: process.env.SKILLS_PROVIDER || 'http_worker',
    skills: filtered
  };
}

export async function getSkillFromCatalog(skillKey) {
  const adapter = getSkillsAdapter();
  const catalog = await adapter.listSkills();
  const skill = catalog.skills.find((s) => s.key === skillKey);
  if (!skill) {
    throw createError(SKILLS_ERROR_CODES.SKILL_NOT_FOUND, `Runtime skill not found: ${skillKey}`);
  }
  return skill;
}
