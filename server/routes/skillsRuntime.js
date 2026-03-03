import { Router } from 'express';
import * as response from '../utils/response.js';
import { validateBody, validateParams, validateQuery, idParamSchema, skillsRuntimeCatalogQuerySchema, createSkillsInvocationSchema, cancelSkillsInvocationSchema } from '../utils/validation.js';
import { anyAuth } from '../middleware/anyAuth.js';
import { userAuthProbe } from '../middleware/userAuth.js';
import { internalServiceAuthProbe } from '../middleware/internalServiceAuth.js';
import { createInvocation, getInvocationById, cancelInvocation, getHealthSnapshot } from '../services/skills/invocationService.js';
import { listCatalogForActor } from '../services/skills/catalogService.js';
import { getSkillsPollerState } from '../services/skills/poller.js';
import { SKILLS_ERROR_CODES } from '../services/skills/types.js';

const router = Router();

const runtimeAuth = anyAuth([userAuthProbe, internalServiceAuthProbe]);

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function sendRuntimeError(res, err) {
  const code = err.code || SKILLS_ERROR_CODES.UPSTREAM_ERROR;
  const status = code === SKILLS_ERROR_CODES.DEPENDENCY_NOT_READY
    ? 409
    : (err.status || (
      code === SKILLS_ERROR_CODES.POLICY_DENIED ? 403 :
      code === SKILLS_ERROR_CODES.INPUT_VALIDATION_FAILED ? 422 :
      code === SKILLS_ERROR_CODES.SKILL_NOT_FOUND ? 404 :
      code === SKILLS_ERROR_CODES.PROVIDER_UNAVAILABLE ? 503 :
      code === SKILLS_ERROR_CODES.TIMEOUT ? 504 : 400
    ));
  const payload = {
    success: false,
    error: {
      code,
      message: err.message || 'Runtime skills request failed'
    }
  };
  if (isPlainObject(err.details)) {
    payload.error.details = err.details;
  }
  return res.status(status).json(payload);
}

router.get('/catalog', runtimeAuth, validateQuery(skillsRuntimeCatalogQuerySchema), async (req, res) => {
  try {
    const data = await listCatalogForActor({
      auth: req.auth,
      user: req.user,
      workspaceId: req.query.workspaceId || null
    });
    response.success(res, data);
  } catch (err) {
    console.error('[SkillsRuntime] Catalog error:', err);
    sendRuntimeError(res, err);
  }
});

router.post('/invocations', runtimeAuth, validateBody(createSkillsInvocationSchema), async (req, res) => {
  try {
    const invocation = await createInvocation(req.body, {
      auth: req.auth,
      user: req.user
    });
    response.created(res, invocation);
  } catch (err) {
    console.error('[SkillsRuntime] Create invocation error:', err);
    sendRuntimeError(res, err);
  }
});

router.get('/invocations/:id', runtimeAuth, validateParams(idParamSchema), async (req, res) => {
  try {
    const invocation = await getInvocationById(req.params.id, req.auth);
    response.success(res, invocation);
  } catch (err) {
    console.error('[SkillsRuntime] Get invocation error:', err);
    sendRuntimeError(res, err);
  }
});

router.post('/invocations/:id/cancel', runtimeAuth, validateParams(idParamSchema), validateBody(cancelSkillsInvocationSchema), async (req, res) => {
  try {
    const invocation = await cancelInvocation(req.params.id, req.auth);
    response.success(res, invocation);
  } catch (err) {
    console.error('[SkillsRuntime] Cancel invocation error:', err);
    sendRuntimeError(res, err);
  }
});

router.get('/health', runtimeAuth, async (req, res) => {
  try {
    if (req.auth?.type === 'user' && req.user?.role !== 'admin') {
      return response.forbidden(res, 'Access denied');
    }

    const health = await getHealthSnapshot();
    response.success(res, {
      ...health,
      poller: getSkillsPollerState()
    });
  } catch (err) {
    console.error('[SkillsRuntime] Health error:', err);
    sendRuntimeError(res, err);
  }
});

export default router;
