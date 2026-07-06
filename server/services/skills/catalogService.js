import db from '../../db/adapter.js';
import { SKILLS_ERROR_CODES } from './types.js';
import { getSkillsAdapter } from './adapters/httpWorkerAdapter.js';

function createError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function attachDetails(err, details) {
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    err.details = details;
  }
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
    const workspaceValue = parseWorkspaceId(workspaceId);
    const hasExplicitPolicy = Boolean(policy);
    const deniedReason = hasExplicitPolicy ? 'policy_forbidden' : 'no_matching_policy';
    const scopeLabel = workspaceValue ? `workspace ${workspaceValue}` : 'global scope';
    const message = hasExplicitPolicy
      ? `Runtime skill ${skillKey} is blocked by policy for role ${role} in ${scopeLabel}`
      : `Runtime skill ${skillKey} has no allow policy for role ${role} in ${scopeLabel}`;
    throw attachDetails(
      createError(SKILLS_ERROR_CODES.POLICY_DENIED, message),
      {
        denied_reason: deniedReason,
        skill_key: skillKey,
        role,
        workspace_id: workspaceValue,
        matched_policy: hasExplicitPolicy
          ? {
              skill_key: policy.skill_key,
              role: policy.role,
              workspace_id: policy.workspace_id,
              allow_catalog: policy.allow_catalog,
              allow_invoke: policy.allow_invoke,
            }
          : null,
      }
    );
  }
  return policy;
}

export async function listCatalogForActor({ auth, user, workspaceId = null }) {
  const role = getEffectiveRole(auth, user);
  let catalogSkills = [];

  const adapter = getSkillsAdapter();
  const catalog = await adapter.listSkills();
  if (Array.isArray(catalog?.skills)) {
    catalogSkills = catalog.skills;
  }

  const filtered = [];
  for (const skill of catalogSkills) {
    const policy = await resolvePolicy(skill.key, role, workspaceId);
    if (policy && policy.allow_catalog) {
      filtered.push(skill);
    }
  }

  return {
    provider: process.env.SKILLS_PROVIDER || 'http_worker',
    providers: [process.env.SKILLS_PROVIDER || 'http_worker'],
    skills: filtered
  };
}

export async function getSkillFromCatalog(skillKey, skillVersion = null, { allowVersionFallback = false } = {}) {
  const requestedVersion = String(skillVersion || '').trim();
  const adapter = getSkillsAdapter();
  const catalog = await adapter.listSkills();
  const skill = catalog.skills.find((s) => {
    if (s.key !== skillKey) return false;
    if (!requestedVersion) return true;
    const catalogVersion = String(s.version || s.skill_version || '').trim();
    return catalogVersion === requestedVersion;
  });
  if (!skill) {
    if (requestedVersion && allowVersionFallback) {
      const fallbackByKey = catalog.skills.find((s) => s.key === skillKey);
      if (fallbackByKey) return fallbackByKey;
    }
    const suffix = requestedVersion ? `@${requestedVersion}` : '';
    throw createError(SKILLS_ERROR_CODES.SKILL_NOT_FOUND, `Runtime skill not found: ${skillKey}${suffix}`);
  }
  return skill;
}
