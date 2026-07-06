# Cavendo Engine Skills Wrapper Spec (v1)

Status: Draft for Engine OSS implementation
Target repo: `cavendo-engine` (open source)
Date: March 2, 2026

## 1. Purpose

Define the Engine-side, runtime-agnostic skills wrapper so:
- Engine can invoke real tooling skills through a provider adapter
- contributors can add skills without changing core orchestration code
- Hosted deployments can plug in a remote worker while self-hosters can use local/remote providers

This spec is intentionally provider-neutral and should live in OSS.

## 2. Design Goals

1. Runtime agnostic: Engine does not depend on one worker implementation.
2. Stable contract: one invocation API regardless of provider backend.
3. Contributor friendly: skill manifests + schemas are easy to add/test.
4. Safe by default: capability gating, approval flags, and audit trail.
5. Backward compatible: existing agent/task flows continue unchanged when skills are disabled.

## 3. Non-Goals (v1)

- Full marketplace/payment model
- Distributed workflow engine rewrite
- Replacing existing agent task execution pipeline

## 4. Engine Module Boundaries

Add new module namespace:

- `engine/server/services/skills/types.js`
- `engine/server/services/skills/registry.js`
- `engine/server/services/skills/providerAdapter.js`
- `engine/server/services/skills/invocationService.js`
- `engine/server/services/skills/contextInjector.js`
- `engine/server/routes/skillsRuntime.js`

Responsibilities:
- `registry`: loads/validates skill manifests
- `providerAdapter`: pluggable provider contract (local, http worker, future)
- `invocationService`: create/poll/cancel invocations + persistence
- `contextInjector`: maps structured outputs into agent/task context
- `routes`: authenticated API for listing/invoking skills

## 5. Core Domain Types

```ts
export type SkillRef = {
  id: string;
  version?: string;
};

export type SkillInvocationRequest = {
  scopeId?: number; // optional in pure OSS mode
  actor: { type: 'user' | 'agent' | 'system'; id?: number | string };
  skill: SkillRef;
  inputs: Record<string, unknown>;
  context?: {
    taskId?: number;
    deliverableId?: number;
    workflowRunId?: number;
    triggerSource?: string;
  };
  limits?: {
    timeoutSeconds?: number;
    maxAttempts?: number;
  };
  idempotencyKey?: string;
};

export type SkillInvocationResult = {
  invocationId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
  outputs?: Record<string, unknown>;
  artifacts?: Array<{ type: string; uri: string; metadata?: Record<string, unknown> }>;
  error?: { code: string; message: string; retryable?: boolean };
  cost?: Record<string, number>;
  startedAt?: string;
  completedAt?: string;
};
```

## 6. Provider Adapter Contract

Engine wraps providers through a strict interface:

```ts
export interface SkillProviderAdapter {
  name(): string;

  listSkills(): Promise<Array<{
    id: string;
    version: string;
    description?: string;
    inputSchema?: object;
    outputSchema?: object;
    capabilities?: string[];
  }>>;

  invoke(request: SkillInvocationRequest): Promise<{ invocationId: string; status: 'queued' | 'running' | 'completed' }>;

  getInvocation(invocationId: string): Promise<SkillInvocationResult>;

  cancelInvocation(invocationId: string): Promise<{ cancelled: boolean }>;

  health(): Promise<{ ok: boolean; detail?: string }>;
}
```

Default adapters:
1. `http-worker-adapter` (for Hosted deployments remote worker)
2. `local-process-adapter` (self-hosted fallback)

## 7. Skill Manifest Contract (OSS)

Canonical file: `SKILL.md` with YAML frontmatter.

Required frontmatter fields:
- `name`
- `slug`
- `version`
- `description`
- `inputs` (name/type/required/description)
- `outputs` (name/type/description)
- `capabilities` (array)

Optional:
- `approval_required`
- `estimated_cost`
- `estimated_duration_seconds`
- `tags`

Validation rules:
- slug must be unique
- version semver required
- input/output shapes must compile to JSON schema

## 8. Engine API Surface

Mount new routes under `/api/skills-runtime`.

### GET `/api/skills-runtime/catalog`
Return merged catalog from registry/provider.

### POST `/api/skills-runtime/invocations`
Create invocation.

### GET `/api/skills-runtime/invocations/:id`
Status/result.

### POST `/api/skills-runtime/invocations/:id/cancel`
Cancel invocation.

### GET `/api/skills-runtime/health`
Adapter + provider health summary.

Auth model:
- user auth + role checks
- optional agent auth for agent-triggered runs

## 9. Persistence (Engine)

Add tables (SQLite + PG compatible migrations):

1. `skill_invocations`
- `id` (text pk)
- `provider` (text)
- `skill_id` (text)
- `skill_version` (text)
- `status` (text)
- `actor_type` (text)
- `actor_id` (text nullable)
- `scope_id` (int nullable)
- `task_id` (int nullable)
- `context` (json)
- `inputs` (json)
- `outputs` (json nullable)
- `error_code` (text nullable)
- `error_message` (text nullable)
- `cost` (json nullable)
- `idempotency_key` (text nullable unique)
- `created_at`, `started_at`, `completed_at`

2. `skill_invocation_artifacts`
- `id` (integer pk)
- `invocation_id` (text fk)
- `artifact_type` (text)
- `uri` (text)
- `metadata` (json)
- `created_at`

3. `skill_catalog_cache` (optional)
- cached provider catalog + checksum

## 10. Execution Lifecycle

1. API receives invocation request.
2. Validate input against manifest schema.
3. Enforce capability/approval policy.
4. Persist `skill_invocations` row as `queued`.
5. Delegate to adapter `.invoke()`.
6. Poll provider or accept callback to update status.
7. On terminal state, persist outputs/artifacts/cost.
8. Inject `outputs.context_data` into task/agent context when requested.
9. Emit audit event (`skills.invocation.completed|failed`).

## 11. Capability and Policy Gating

Engine policy layer should block invocation when:
- skill capability not allowed for deployment policy
- approval-required skill called without approval token
- deployment quota exceeded
- actor lacks permission

Policy source order:
1. global defaults
2. deployment overrides
3. request-level limits (can only tighten, not expand)

## 12. Context Injection Rules

If output includes `context_data`:
- merge into structured task context as `skills[slug]`
- preserve original output under `raw_output_ref` (pointer)
- cap context payload size; large payloads remain artifact-backed

Never inject:
- raw HTML blobs
- executable script strings
- unbounded arrays/documents

## 13. Error Model

Standard error codes:
- `SKILL_NOT_FOUND`
- `INPUT_VALIDATION_FAILED`
- `PROVIDER_UNAVAILABLE`
- `TIMEOUT`
- `CANCELLED`
- `UPSTREAM_ERROR`
- `POLICY_DENIED`

Retryable classification belongs in the result payload (`retryable=true|false`).

## 14. Observability

Emit metrics:
- `skills_invocations_total{skill,status}`
- `skills_invocation_duration_ms{skill}`
- `skills_invocation_cost_usd_total{skill}`
- `skills_provider_errors_total{provider,code}`

Log keys:
- `invocation_id`
- `skill_id`
- `actor_type`
- `scope_id`
- `provider`

## 15. OSS Contributor Workflow

Contributors adding a skill should only need to:
1. add `SKILL.md`
2. add schemas/tests
3. optionally add provider-specific runtime script
4. register in catalog index

No core engine code changes required for normal additions.

## 16. Phased Implementation

Phase 1:
- types + provider adapter + basic routes + persistence
- HTTP worker adapter only

Phase 2:
- policy gating + approval integration + context injection
- metrics/audit events

Phase 3:
- local-process adapter for self-hosted mode
- docs/examples for community skill contributions

## 17. Compatibility Notes with Existing Skill Catalogs

Existing `skills` tables can represent employee/profile competencies rather than runtime-executed tool skills. Keep both concepts separate:
- `competencies` (agent profile and planning hints)
- `runtime skills` (actual executed tools)

Recommendation:
- in Engine OSS, name runtime tables/services with explicit `skill_invocation*`
- avoid overloading existing `skills` CRUD paths for runtime execution
