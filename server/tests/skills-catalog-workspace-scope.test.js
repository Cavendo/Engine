import { describe, expect, test, jest, beforeEach } from '@jest/globals';
import { HttpWorkerAdapter } from '../services/skills/adapters/httpWorkerAdapter.js';

// The worker's skill catalogue is SHARED unless a workspace scope is supplied.
// A skill registered for one workspace is invisible to an unscoped lookup, so
// the lookup answers "not found" while the handler is deployed and healthy.
// Three legs carry the scope: adapter -> HTTP query, catalogService -> adapter,
// createInvocation -> catalogService. Each is pinned below.

function stubFetch(payload) {
  const calls = [];
  global.fetch = jest.fn(async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  });
  return calls;
}

describe('skills catalogue workspace scoping', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('leg 1: adapter puts the scope on the wire', () => {
    test('listSkills requests workspace_id when a scope is supplied', async () => {
      const calls = stubFetch({ skills: [] });
      const adapter = new HttpWorkerAdapter('http://worker.local');

      await adapter.listSkills({ workspaceId: 77 });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('http://worker.local/v1/skills?workspace_id=77');
    });

    test('listSkills omits workspace_id entirely when unscoped', async () => {
      const calls = stubFetch({ skills: [] });
      const adapter = new HttpWorkerAdapter('http://worker.local');

      await adapter.listSkills();

      expect(calls[0].url).toBe('http://worker.local/v1/skills');
      expect(calls[0].url).not.toContain('workspace_id');
    });

    test('a scope needing encoding is encoded, not concatenated raw', async () => {
      const calls = stubFetch({ skills: [] });
      const adapter = new HttpWorkerAdapter('http://worker.local');

      await adapter.listSkills({ workspaceId: 'ws 1&2' });

      expect(calls[0].url).toBe('http://worker.local/v1/skills?workspace_id=ws%201%262');
    });

    test('an empty or whitespace scope is treated as unscoped, not sent blank', async () => {
      const calls = stubFetch({ skills: [] });
      const adapter = new HttpWorkerAdapter('http://worker.local');

      await adapter.listSkills({ workspaceId: '   ' });
      await adapter.listSkills({ workspaceId: null });

      expect(calls[0].url).toBe('http://worker.local/v1/skills');
      expect(calls[1].url).toBe('http://worker.local/v1/skills');
    });
  });

  describe('leg 2: catalogService hands the scope to the adapter', () => {
    let listSkills;
    let getSkillFromCatalog;

    beforeEach(async () => {
      jest.resetModules();
      listSkills = jest.fn(async () => ({ skills: [] }));
      jest.unstable_mockModule('../services/skills/adapters/httpWorkerAdapter.js', () => ({
        getSkillsAdapter: () => ({ listSkills }),
        HttpWorkerAdapter: class {}
      }));
      ({ getSkillFromCatalog } = await import('../services/skills/catalogService.js'));
    });

    test('getSkillFromCatalog forwards the workspace scope', async () => {
      listSkills.mockResolvedValue({
        skills: [{ key: 'authority_mutation_probe', version: '1.0.0', input_schema: null }]
      });

      const skill = await getSkillFromCatalog('authority_mutation_probe', null, { workspaceId: 77 });

      expect(listSkills).toHaveBeenCalledWith({ workspaceId: 77 });
      expect(skill.key).toBe('authority_mutation_probe');
    });

    test('an unscoped call still reaches the adapter with an explicit null scope', async () => {
      listSkills.mockResolvedValue({ skills: [{ key: 'seo_audit', version: '1.0.0' }] });

      await getSkillFromCatalog('seo_audit');

      expect(listSkills).toHaveBeenCalledWith({ workspaceId: null });
    });

    test('a skill absent from the scoped catalogue is NOT_FOUND, never a shared-catalogue retry', async () => {
      listSkills.mockResolvedValue({ skills: [{ key: 'some_other_skill', version: '1.0.0' }] });

      await expect(
        getSkillFromCatalog('authority_mutation_probe', null, { workspaceId: 77 })
      ).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' });

      expect(listSkills).toHaveBeenCalledTimes(1);
      expect(listSkills).toHaveBeenCalledWith({ workspaceId: 77 });
    });
  });

  describe('leg 3: createInvocation scopes its own second lookup', () => {
    let createInvocation;
    let getSkillFromCatalog;
    let invoke;

    const ACTOR = { auth: { actorType: 'user', actorId: 'user:9' }, user: { role: 'admin' } };

    beforeEach(async () => {
      jest.resetModules();

      getSkillFromCatalog = jest.fn(async () => ({
        key: 'authority_mutation_probe',
        version: '1.0.0',
        input_schema: null
      }));
      invoke = jest.fn(async () => ({ job_id: 'job_1', status: 'queued' }));

      jest.unstable_mockModule('../services/skills/catalogService.js', () => ({
        getSkillFromCatalog,
        assertInvokeAllowed: jest.fn(async () => {}),
        getEffectiveRole: () => 'admin'
      }));

      // Discriminates on SQL so the idempotency probe misses (no prior row) while
      // the post-insert read hits, the same way the real table behaves.
      const one = jest.fn(async (sql, params) => {
        if (/idempotency_key/.test(sql)) return null;
        if (/FROM skill_invocations WHERE id = \?/.test(sql)) {
          return {
            id: params[0],
            actor_type: 'user',
            actor_id: 'user:9',
            workspace_id: 77,
            skill_key: 'authority_mutation_probe',
            skill_version: '1.0.0',
            status: 'queued',
            input_json: '{}',
            context_json: '{}',
            output_json: null,
            error_detail_json: null
          };
        }
        return null;
      });

      jest.unstable_mockModule('../db/adapter.js', () => ({
        default: {
          one,
          many: jest.fn(async () => []),
          exec: jest.fn(async () => ({ rowCount: 1 })),
          insert: jest.fn(async () => ({ lastInsertRowid: 501 })),
          tx: jest.fn(async (fn) => fn({
            one,
            many: jest.fn(async () => []),
            insert: jest.fn(async () => ({ lastInsertRowid: 501 })),
            exec: jest.fn(async () => ({ rowCount: 1 }))
          }))
        }
      }));

      jest.unstable_mockModule('../services/skills/adapters/httpWorkerAdapter.js', () => ({
        getSkillsAdapter: () => ({ invoke, listSkills: jest.fn(async () => ({ skills: [] })) }),
        HttpWorkerAdapter: class {}
      }));

      ({ createInvocation } = await import('../services/skills/invocationService.js'));
    });

    test('the invocation workspace reaches the catalogue lookup and the invocation is created', async () => {
      const result = await createInvocation({
        skillKey: 'authority_mutation_probe',
        idempotencyKey: 'idem-1',
        workspaceId: 77,
        inputs: {}
      }, ACTOR);

      expect(getSkillFromCatalog).toHaveBeenCalledWith(
        'authority_mutation_probe',
        null,
        expect.objectContaining({ workspaceId: 77 })
      );
      expect(result.id).toBe(501);
      expect(invoke).toHaveBeenCalledTimes(1);
    });

    test('an invocation with no workspace passes an explicit null, not undefined', async () => {
      await createInvocation({ skillKey: 'seo_audit', idempotencyKey: 'idem-2', inputs: {} }, ACTOR);

      expect(getSkillFromCatalog).toHaveBeenCalledWith(
        'seo_audit',
        null,
        expect.objectContaining({ workspaceId: null })
      );
    });

    test('a catalogue miss aborts before any invocation row is written', async () => {
      const notFound = Object.assign(new Error('Skill not found'), { code: 'SKILL_NOT_FOUND' });
      getSkillFromCatalog.mockRejectedValue(notFound);

      await expect(createInvocation({
        skillKey: 'authority_mutation_probe',
        idempotencyKey: 'idem-3',
        workspaceId: 77,
        inputs: {}
      }, ACTOR)).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' });

      expect(invoke).not.toHaveBeenCalled();
    });
  });
});
