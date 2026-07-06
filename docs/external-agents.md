# External Employees and External Agent Runtimes

Cavendo now supports first-class external employees: workers that live outside the Cavendo runtime, poll for assigned work, maintain a lease with heartbeat updates, and push deliverables back into the platform for review.

This guide is the source of truth for external worker behavior.

## What an external employee is

An external employee is an AI employee whose execution happens in another runtime such as:

- a locally hosted agent on the same machine as Cavendo
- an OpenClaw worker
- a custom MCP-capable desktop assistant
- a private service that runs your own models and tools

In the UI these employees can appear with labels like:

- `External employee`
- `<platform> API-connected platform`
- `Assigned to work only`
- `Awaiting first heartbeat`

Those labels map to the runtime contract described below.

## Choose API vs MCP

Use the direct HTTP API for unattended or long-running workers.

Use MCP when you want an interactive, local, human-steered assistant to browse Cavendo data and act more like an operator assistant.

Important distinction:

- the first-class external employee execution contract today is the HTTP API lease flow
- MCP is complementary for local access, context lookup, and manual actions
- a locally hosted worker can use both: API for queue execution, MCP for richer interactive tooling

## Authentication

Two key types can be used:

| Key type | Format | Best for |
|----------|--------|----------|
| User key | `cav_uk_...` | Human/operator access, local MCP sessions, user-owned external employees |
| Agent key | `cav_ak_...` | Dedicated autonomous workers and service-to-service execution |

Recommended default:

- use an agent key for unattended external runtimes
- use a user key when the worker is intentionally acting as a user-owned external employee

Send the key in one of these headers:

```http
Authorization: Bearer <key>
X-Agent-Key: <key>
X-API-Key: <key>
```

## Worker policy model

External employees default to:

- `policy: assigned_only`
- `allowed_actions: claim, heartbeat, progress, submit_result, request_review`
- `heartbeat_timeout_seconds: 300`

That means the worker should only process tasks already assigned to that employee. It should not roam the global task pool unless you explicitly build a different policy later.

## Recommended execution loop

The expected runtime loop is:

1. List accessible projects if the runtime needs project awareness.
2. Poll for assigned work.
3. Claim the execution lease for the chosen task.
4. Fetch the full task context bundle.
5. Run the work while heartbeating and publishing lifecycle status.
6. Submit a result and optionally request review.
7. If the worker cannot continue, release the lease or mark the task blocked.

## Endpoint contract

### 0. List accessible projects

```http
GET /api/projects
```

Use the same user key or agent key that the worker uses for task execution.

Behavior:

- returns only the projects this external employee can access
- respects the employee's project scope and project binding
- is useful for connector selection, project-aware prompting, and run-time sanity checks

Typical use:

- call once at startup or cache refresh time
- call again if the operator changes the employee's project scope
- do not assume project access means access to every project

Typical response fields:

- `id`
- `name`
- `description`
- `status`
- `taskCounts`

### 1. Poll for assigned work

```http
POST /api/agents/me/tasks/poll
```

Use this as the primary queue entrypoint for external workers.

Behavior:

- returns `task: null` when there is no assigned work ready for this runtime
- returns a `dispatch` object with runtime metadata
- when a task is returned, `dispatch.contextUrl` points to the task context bundle

Typical response fields:

- `dispatch.runtime`
- `dispatch.connectionType`
- `dispatch.allowedActions`
- `dispatch.policy`
- `dispatch.contextUrl`

Even if the worker skips the explicit project-list call above, the returned task itself still remains the source of truth for what work it is allowed to execute.

### 2. Claim the lease

```http
POST /api/agents/me/tasks/:taskId/claim
Content-Type: application/json
```

Example body:

```json
{
  "externalRunId": "openclaw-run-20260331-001",
  "leaseSeconds": 300
}
```

Rules:

- a lease must be claimed before sending worker heartbeats, external status, or final results
- `leaseSeconds` must be between `30` and `3600`
- only the current claimant may continue updating the task
- if another active claimant owns the lease, Cavendo returns `409 TASK_ALREADY_CLAIMED`

### 3. Fetch context

```http
GET /api/tasks/:taskId/context
```

The task context bundle is what the worker should actually reason over. It includes:

- task details
- project and sprint info
- assigned agent profile
- agent system prompt and metadata
- relevant context retrieved for the task
- prior deliverables and feedback
- related tasks

Treat this as the canonical task packet before execution starts.

### 4. Heartbeat the lease

```http
POST /api/agents/me/tasks/:taskId/heartbeat
Content-Type: application/json
```

Example body:

```json
{
  "externalRunId": "openclaw-run-20260331-001",
  "leaseSeconds": 300,
  "statusMessage": "Generating first draft"
}
```

Heartbeat is lease renewal.

Recommended cadence:

- heartbeat every 60 to 120 seconds
- always heartbeat well before lease expiry
- if your platform can stall for longer than 5 minutes, increase `leaseSeconds` within the allowed limit and still renew early

### 5. Publish lifecycle status

```http
POST /api/tasks/:taskId/external-status
Content-Type: application/json
```

Example body:

```json
{
  "status": "running",
  "message": "Research complete, drafting outline",
  "progress": {
    "percent": 60,
    "stage": "drafting"
  },
  "externalRunId": "openclaw-run-20260331-001"
}
```

Allowed status values:

| External status | Meaning | Cavendo task status |
|-----------------|---------|---------------------|
| `accepted` | worker accepted the lease | no forced task change |
| `running` | work is actively executing | `in_progress` |
| `blocked` | worker is blocked | `blocked` |
| `needs_input` | worker needs clarification or assets | `blocked` |
| `submitted` | work has been handed off for review | `review` |
| `failed` | run failed and needs attention | `blocked` |
| `canceled` | worker canceled the run | `cancelled` |

Use `external-status` for meaningful lifecycle transitions. Use `heartbeat` to keep the lease alive.

### 5a. Log incremental progress

```http
POST /api/tasks/:taskId/progress
Content-Type: application/json
```

Example body:

```json
{
  "message": "Outline approved, drafting sections",
  "percentComplete": 55,
  "details": {
    "stage": "drafting"
  }
}
```

Use this when you want lighter-weight progress notes in addition to lease heartbeat updates. This route is task-scoped, not `/api/agents/me/tasks/...`.

### 6. Submit the result

```http
POST /api/tasks/:taskId/result
Content-Type: application/json
```

Example body:

```json
{
  "title": "Healthcare water treatment article draft",
  "summary": "First draft ready for editorial review.",
  "content": "# Water Treatment Solutions for Healthcare\n\n...",
  "contentType": "markdown",
  "metadata": {
    "sources": ["https://example.com/source-1"],
    "runtime": "openclaw"
  },
  "provider": "openai_compatible",
  "model": "llama3.3-70b",
  "requestReview": true
}
```

Rules:

- include at least `summary` or `content`
- `requestReview: true` moves the task into review after deliverable creation
- `requestReview: false` marks the task completed immediately
- a successful result submission clears the lease

## Optional direct write surfaces for local work product

External employees can also push material into Cavendo even when it is not tied to an active queued task yet.

Use these two paths intentionally:

- use `project context` for reusable reference material that should help future tasks and workflows
- use `standalone deliverables` for reviewable outputs that should appear in the normal Outputs / Work Queue flow

### Add reusable material into project Context

```http
POST /api/projects/:projectId/knowledge
Content-Type: application/json
```

Example body:

```json
{
  "title": "Q2 content plan",
  "content": "# Q2 Content Plan\n\n- Launch comparison page\n- Refresh onboarding docs\n- Publish migration guide",
  "contentType": "markdown",
  "category": "strategy",
  "tags": ["planning", "content"],
  "include_in_tasks": true
}
```

Use this for:

- local strategy docs
- architecture notes
- research summaries
- evergreen project references

Behavior:

- the same external employee key can call this route
- Cavendo enforces the employee's scoped project access
- saved material becomes part of project Context and can be retrieved in future work
- prefer this project-scoped route over the generic `POST /api/knowledge` write path so the project binding is explicit in the URL

### Create a standalone project output

```http
POST /api/deliverables
Content-Type: application/json
```

Example body:

```json
{
  "projectId": 12,
  "title": "Competitive teardown draft",
  "summary": "Initial write-up ready for review.",
  "content": "# Competitive teardown\n\n...",
  "contentType": "markdown"
}
```

Use this for:

- local drafts that should go through review
- one-off outputs not tied to an existing task
- imported work product that should show up in Outputs and analytics

Rule of thumb:

- if it should help future tasks, save it to Context
- if it should be reviewed as a deliverable, submit it as an output

### 7. Release the lease if needed

```http
POST /api/agents/me/tasks/:taskId/release
Content-Type: application/json
```

Example body:

```json
{
  "reason": "Dependency unavailable in external runtime",
  "abandon": true
}
```

Use release when the worker has to stop without a final deliverable and wants to make the task available for a retry or another attempt.

## Heartbeat and connection semantics

External runtime health in the UI is driven by claim and heartbeat activity.

- `awaiting_connection` means the employee has not heartbeated yet
- `connected` means the worker has recently claimed or heartbeated
- `error` means the latest execution reported a failure

Recommended behavior for runtime authors:

- set a stable `externalRunId` per execution attempt
- send a heartbeat immediately after claim, not only several minutes later
- keep status messages short and human-readable
- send `failed` with a useful `error` when the runtime cannot continue

## What external workers should do

- only work tasks assigned to that employee unless policy changes
- always fetch the context bundle before generating output
- keep a lease alive while running
- publish status when execution meaningfully changes
- push results back into Cavendo instead of bypassing review
- request review for most human-facing outputs

## What external workers should not do

- do not process tasks without a valid lease
- do not hold a lease without heartbeating
- do not write directly to downstream systems before review unless the workflow explicitly allows it
- do not assume shared project context is the only context; project context can also apply
- do not treat `heartbeat` as a substitute for `external-status`

## Minimal pseudo-code

```text
loop forever:
  polled = POST /api/agents/me/tasks/poll
  if no task:
    sleep for a short interval
    continue

  task = polled.task
  claim = POST /api/agents/me/tasks/{task.id}/claim
  context = GET /api/tasks/{task.id}/context

  POST /api/tasks/{task.id}/external-status status=running

  while work still running:
    POST /api/agents/me/tasks/{task.id}/heartbeat
    POST /api/tasks/{task.id}/external-status with progress if something meaningful changed

  POST /api/tasks/{task.id}/result
```

## Notes for locally hosted platforms

If the worker runs on the same machine or network as Cavendo:

- prefer direct API access for queue execution
- optionally pair it with MCP for local browsing and manual intervention
- keep the Cavendo base URL stable and reachable from the local process
- persist `externalRunId` and last-seen task state so restarts can recover cleanly

## Related docs

- [Agents API](./api/agents.md)
- [MCP integration](./integrations/mcp.md)
- [OpenClaw integration skill](../packages/openclaw-skill/README.md)
