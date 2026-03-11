import { Router } from 'express';
import db from '../db/adapter.js';
import * as response from '../utils/response.js';
import { isUniqueViolation } from '../db/errors.js';
import { internalServiceAuth } from '../middleware/internalServiceAuth.js';
import {
  validateBody,
  validateParams,
  ensureProjectSchema,
  ensureProjectRoutingSchema,
  externalKeyParamSchema
} from '../utils/validation.js';
import { dispatchEvent } from '../services/routeDispatcher.js';

const router = Router();

function formatProject(project) {
  return {
    id: project.id,
    externalKey: project.external_key,
    name: project.name,
    description: project.description,
    status: project.status
  };
}

async function getProjectByExternalKey(externalKey) {
  return db.one(
    'SELECT id, external_key, name, description, status, task_routing_rules, default_agent_id FROM projects WHERE external_key = ?',
    [externalKey]
  );
}

async function getDefaultAgent(defaultAgentId) {
  if (!defaultAgentId) return null;
  return db.one('SELECT id, name, status FROM agents WHERE id = ?', [defaultAgentId]);
}

async function validateRoutingReferences(taskRoutingRules, defaultAgentId) {
  if (defaultAgentId) {
    const agent = await db.one('SELECT id FROM agents WHERE id = ?', [defaultAgentId]);
    if (!agent) {
      return `Agent with ID ${defaultAgentId} not found`;
    }
  }

  for (const rule of taskRoutingRules) {
    if (rule.assign_to) {
      const agent = await db.one('SELECT id FROM agents WHERE id = ?', [rule.assign_to]);
      if (!agent) {
        return `Agent with ID ${rule.assign_to} in rule "${rule.name}" not found`;
      }
    }
    if (rule.fallback_to) {
      const agent = await db.one('SELECT id FROM agents WHERE id = ?', [rule.fallback_to]);
      if (!agent) {
        return `Fallback agent with ID ${rule.fallback_to} in rule "${rule.name}" not found`;
      }
    }
  }

  return null;
}

async function updateProjectByExternalKey(externalKey, payload) {
  const updates = ['name = ?'];
  const values = [payload.name];

  if (Object.prototype.hasOwnProperty.call(payload, 'description')) {
    updates.push('description = ?');
    values.push(payload.description ?? null);
  }
  if (payload.status !== undefined) {
    updates.push('status = ?');
    values.push(payload.status);
  }

  updates.push("updated_at = datetime('now')");
  values.push(externalKey);

  await db.exec(
    `UPDATE projects SET ${updates.join(', ')} WHERE external_key = ?`,
    values
  );

  return getProjectByExternalKey(externalKey);
}

async function ensureProject(payload) {
  const existing = await getProjectByExternalKey(payload.externalKey);
  if (existing) {
    const updated = await updateProjectByExternalKey(payload.externalKey, payload);
    return { created: false, project: updated };
  }

  const nameConflict = await db.one(
    'SELECT id FROM projects WHERE LOWER(name) = LOWER(?)',
    [payload.name]
  );
  if (nameConflict) {
    const err = new Error(`Project name "${payload.name}" already exists`);
    err.status = 409;
    err.code = 'PROJECT_NAME_CONFLICT';
    throw err;
  }

  try {
    const { lastInsertRowid } = await db.insert(
      `INSERT INTO projects (name, external_key, description, status)
       VALUES (?, ?, ?, ?)`,
      [
        payload.name,
        payload.externalKey,
        payload.description ?? null,
        payload.status || 'active'
      ]
    );

    const project = await db.one(
      'SELECT id, external_key, name, description, status FROM projects WHERE id = ?',
      [lastInsertRowid]
    );

    return { created: true, project };
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err;
    }

    const concurrent = await getProjectByExternalKey(payload.externalKey);
    if (!concurrent) {
      throw err;
    }

    const updated = await updateProjectByExternalKey(payload.externalKey, payload);
    return { created: false, project: updated };
  }
}

router.post('/projects/ensure', internalServiceAuth, validateBody(ensureProjectSchema), async (req, res) => {
  try {
    const result = await ensureProject(req.body);

    if (result.created) {
      dispatchEvent('project.created', {
        project: { id: result.project.id, name: result.project.name },
        projectId: result.project.id,
        description: result.project.description || null,
        createdBy: req.auth?.serviceName || req.auth?.actorId || 'internal',
        timestamp: new Date().toISOString()
      }).catch(err => console.error('[InternalProvisioning] Route dispatch error:', err));
    }

    const body = {
      created: result.created,
      project: formatProject(result.project)
    };

    if (result.created) {
      return response.created(res, body);
    }
    return response.success(res, body);
  } catch (err) {
    if (err.code === 'PROJECT_NAME_CONFLICT') {
      return response.error(res, err.message, 409, err.code);
    }

    console.error('[InternalProvisioning] Ensure project error:', err);
    return response.serverError(res);
  }
});

router.post(
  '/projects/:externalKey/routing-rules/ensure',
  internalServiceAuth,
  validateParams(externalKeyParamSchema),
  validateBody(ensureProjectRoutingSchema),
  async (req, res) => {
    try {
      const project = await getProjectByExternalKey(req.params.externalKey);
      if (!project) {
        return response.error(res, 'Project not found', 404, 'PROJECT_NOT_FOUND');
      }

      const validationError = await validateRoutingReferences(
        req.body.taskRoutingRules || [],
        req.body.defaultAgentId || null
      );
      if (validationError) {
        return response.validationError(res, validationError);
      }

      await db.exec(
        `UPDATE projects
         SET task_routing_rules = ?, default_agent_id = ?, updated_at = datetime('now')
         WHERE id = ?`,
        [
          JSON.stringify(req.body.taskRoutingRules || []),
          req.body.defaultAgentId || null,
          project.id
        ]
      );

      const defaultAgent = await getDefaultAgent(req.body.defaultAgentId || null);

      return response.success(res, {
        projectId: project.id,
        externalKey: project.external_key,
        taskRoutingRules: req.body.taskRoutingRules || [],
        defaultAgentId: req.body.defaultAgentId || null,
        defaultAgent
      });
    } catch (err) {
      console.error('[InternalProvisioning] Ensure routing rules error:', err);
      return response.serverError(res);
    }
  }
);

export default router;
