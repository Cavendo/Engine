import { describe, expect, test, jest } from '@jest/globals';
import { sendRuntimeError } from '../routes/skillsRuntime.js';
import { SKILLS_ERROR_CODES } from '../services/skills/types.js';

function createRes() {
  const res = {
    statusCode: 200,
    body: null,
    status: jest.fn((code) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn((payload) => {
      res.body = payload;
      return res;
    })
  };
  return res;
}

describe('skills runtime error contract', () => {
  test('maps DEPENDENCY_NOT_READY to HTTP 409 with structured details', () => {
    const res = createRes();
    const err = new Error('Dependency missing');
    err.code = SKILLS_ERROR_CODES.DEPENDENCY_NOT_READY;
    err.details = {
      missing_connectors: ['google:gsc'],
      missing_workspace_config_keys: [],
      missing_secret_keys: [],
      missing_external_services: [],
      missing_permissions: []
    };

    sendRuntimeError(res, err);

    expect(res.statusCode).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(SKILLS_ERROR_CODES.DEPENDENCY_NOT_READY);
    expect(res.body.error.details).toEqual(err.details);
  });

  test('includes POLICY_DENIED denied_reason details', () => {
    const res = createRes();
    const err = new Error('Denied');
    err.code = SKILLS_ERROR_CODES.POLICY_DENIED;
    err.details = { denied_reason: 'policy_forbidden', blocked_connector_id: 'google:gsc' };

    sendRuntimeError(res, err);

    expect(res.statusCode).toBe(403);
    expect(res.body.error.details.denied_reason).toBe('policy_forbidden');
    expect(res.body.error.details.blocked_connector_id).toBe('google:gsc');
  });

  test('omits details when not plain object', () => {
    const res = createRes();
    const err = new Error('unsafe details');
    err.code = SKILLS_ERROR_CODES.UPSTREAM_ERROR;
    err.details = ['raw', 'payload'];

    sendRuntimeError(res, err);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.details).toBeUndefined();
  });

  test('legacy shape works without details', () => {
    const res = createRes();
    const err = new Error('Legacy error');
    err.code = SKILLS_ERROR_CODES.UPSTREAM_ERROR;

    sendRuntimeError(res, err);

    expect(res.body).toEqual({
      success: false,
      error: {
        code: SKILLS_ERROR_CODES.UPSTREAM_ERROR,
        message: 'Legacy error'
      }
    });
  });
});
