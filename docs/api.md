# Cavendo Engine API Reference

## Authentication

All API endpoints require authentication via one of these methods:

### Session Cookie (Web UI)

Login via `/api/auth/login` to receive a session cookie.

### API Key Header

Use `X-Agent-Key` header with either:
- **User Key** (`cav_uk_...`): Acts as the user who generated the key
- **Agent Key** (`cav_ak_...`): Acts as the agent

```bash
curl -H "X-Agent-Key: cav_uk_..." http://localhost:3001/api/agents/me/tasks
```

## Users Endpoints

### GET /api/users/me

Get current user's profile.

**Auth**: Session cookie

**Response**:
```json
{
  "id": 1,
  "email": "user@example.com",
  "name": "John Doe",
  "role": "admin",
  "status": "active",
  "last_login_at": "2026-02-14T10:30:00Z",
  "created_at": "2026-01-01T00:00:00Z"
}
```

### GET /api/users/me/keys

List current user's API keys.

**Auth**: Session cookie

**Response**:
```json
[
  {
    "id": 1,
    "prefix": "cav_uk_abc1234",
    "name": "Claude Desktop",
    "lastUsedAt": "2026-02-14T10:30:00Z",
    "createdAt": "2026-02-01T00:00:00Z"
  }
]
```

### POST /api/users/me/keys

Generate a new personal API key.

**Auth**: Session cookie

**Body**:
```json
{
  "name": "Claude Desktop"
}
```

**Response**:
```json
{
  "id": 1,
  "apiKey": "cav_uk_abc123...",
  "prefix": "cav_uk_abc1234",
  "name": "Claude Desktop",
  "warning": "Store this key securely - it cannot be retrieved again"
}
```

### PATCH /api/users/me/keys/:keyId

Update key name.

**Auth**: Session cookie

**Body**:
```json
{
  "name": "Work Laptop"
}
```

### DELETE /api/users/me/keys/:keyId

Revoke a personal API key.

**Auth**: Session cookie

### GET /api/users

List all users (admin only). Includes linked agent info.

**Auth**: Admin session

**Response**:
```json
[
  {
    "id": 1,
    "email": "sarah@company.com",
    "name": "Sarah Chen",
    "role": "reviewer",
    "status": "active",
    "linked_agent_id": 3,
    "linked_agent_name": "Sarah Chen",
    "linked_agent_status": "active",
    "last_login_at": "2026-02-18T10:00:00Z",
    "created_at": "2026-02-18T09:00:00Z"
  }
]
```

### POST /api/users

Create a new user (admin only). Automatically creates a linked human agent so the user can be assigned tasks.

**Auth**: Admin session + CSRF

**Body**:
```json
{
  "email": "sarah@company.com",
  "password": "securepassword",
  "name": "Sarah Chen",
  "role": "reviewer"
}
```

**Response**: Created user with `linked_agent_id`.

### GET /api/users/:id

Get a specific user (admin only).

**Auth**: Admin session

### PATCH /api/users/:id

Update a user (admin only). Status and name changes cascade to the linked human agent.

**Auth**: Admin session + CSRF

**Body** (all fields optional):
```json
{
  "name": "Sarah Chen-Smith",
  "email": "sarah.new@company.com",
  "role": "admin",
  "status": "inactive"
}
```

Setting `status: "inactive"` disables the user's login and sets their linked agent to `disabled`.

### DELETE /api/users/:id

Delete a user and their linked human agent (admin only). Cannot delete yourself.

**Auth**: Admin session + CSRF

### POST /api/users/:id/reset-password

Reset a user's password (admin only). Invalidates all existing sessions.

**Auth**: Admin session + CSRF

**Body**:
```json
{
  "password": "newsecurepassword"
}
```

## Agents Endpoints

### GET /api/agents

List all agents with optional filtering.

**Auth**: Session cookie (admin)

**Query Parameters**:
- `capability`: Filter by capability (e.g., `code`, `research`)
- `status`: Filter by status (`active`, `paused`, `disabled`)
- `available`: Set to `true` to show only agents with capacity
- `business_line`: Filter by specialization business line

### POST /api/agents/match

Find matching agents for a task (advisory - does not assign).

**Auth**: Session cookie or X-Agent-Key

**Body**:
```json
{
  "tags": ["code-review", "urgent"],
  "priority": 1,
  "metadata": {"language": "python"}
}
```

**Response**:
```json
{
  "matches": [
    {
      "agent": {"id": 1, "name": "Code Reviewer", "capabilities": ["code", "review"]},
      "score": 0.85,
      "reasons": ["Has 'code' capability", "Low workload (1/5 tasks)"]
    }
  ]
}
```

### POST /api/agents

Create a new agent.

**Auth**: Session cookie (admin)

**Body**:
```json
{
  "name": "Code Reviewer",
  "type": "autonomous",
  "description": "Reviews code and suggests improvements",
  "capabilities": ["code", "review"],
  "maxConcurrentTasks": 3
}
```

### GET /api/agents/:id

Get agent details including API keys.

**Auth**: Session cookie

### PATCH /api/agents/:id

Update agent.

**Auth**: Session cookie (admin)

### DELETE /api/agents/:id

Delete agent.

**Auth**: Session cookie (admin)

### GET /api/agents/providers

List supported AI providers and their models.

**Auth**: Session cookie

**Response**:
```json
{
  "anthropic": {
    "name": "Anthropic",
    "models": [
      {"id": "claude-opus-4-20250514", "name": "Claude Opus 4", "description": "Most capable"},
      {"id": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4", "description": "Balanced"},
      {"id": "claude-haiku-4-20250514", "name": "Claude Haiku 4", "description": "Fast"}
    ]
  },
  "openai": {
    "name": "OpenAI",
    "models": [
      {"id": "gpt-4o", "name": "GPT-4o", "description": "Latest multimodal"},
      {"id": "gpt-4-turbo", "name": "GPT-4 Turbo", "description": "Fast"},
      {"id": "gpt-3.5-turbo", "name": "GPT-3.5 Turbo", "description": "Affordable"}
    ]
  }
}
```

### POST /api/agents/:id/keys

Generate a new API key for an agent.

**Auth**: Session cookie (admin)

**Body**:
```json
{
  "name": "Production Key",
  "scopes": ["read", "write"],
  "expiresAt": "2027-01-01T00:00:00Z"
}
```

### DELETE /api/agents/:id/keys/:keyId

Revoke an agent API key.

**Auth**: Session cookie (admin)

### PUT /api/agents/:id/owner

Link or unlink agent to a user.

**Auth**: Session cookie (admin)

**Body**:
```json
{
  "userId": 1
}
```

Set `userId` to `null` to unlink.

### PATCH /api/agents/:id/execution

Update agent execution configuration.

**Auth**: Session cookie (admin)

**Body**:
```json
{
  "provider": "anthropic",
  "providerApiKey": "sk-ant-...",
  "providerModel": "claude-opus-4-20250514",
  "systemPrompt": "You are a code review expert...",
  "executionMode": "manual",
  "maxTokens": 4096,
  "temperature": 0.7
}
```

### POST /api/agents/:id/test-connection

Test provider API key connectivity.

**Auth**: Session cookie (admin)

**Body** (optional - uses saved config if not provided):
```json
{
  "provider": "anthropic",
  "apiKey": "sk-ant-...",
  "model": "claude-opus-4-20250514"
}
```

**Response**:
```json
{
  "success": true,
  "message": "Connection successful"
}
```

### POST /api/agents/:id/execute

Trigger task execution for an agent.

**Auth**: Session cookie (admin)

**Body**:
```json
{
  "taskId": 123
}
```

**Response**:
```json
{
  "success": true,
  "deliverableId": 456,
  "content": "## Code Review\n...",
  "usage": {
    "inputTokens": 1234,
    "outputTokens": 567
  }
}
```

## Agent Self-Service Endpoints

These endpoints are accessed by agents using their API key.

### GET /api/agents/me

Get current agent's details.

**Auth**: X-Agent-Key

### GET /api/agents/me/tasks

Get tasks assigned to current agent.

**Auth**: X-Agent-Key

**Query Parameters**:
- `status`: Filter by status
- `limit`: Max results (default 50)
- `offset`: Pagination offset

### GET /api/agents/me/tasks/next

Get the next task from the queue (highest priority, oldest first).

**Auth**: X-Agent-Key

**Response**:
```json
{
  "task": {
    "id": 123,
    "title": "Review PR #456",
    "description": "...",
    "priority": 1,
    "status": "assigned"
  }
}
```

Or if no tasks available:
```json
{
  "task": null,
  "reason": "no_tasks",
  "message": "No pending tasks assigned to this agent"
}
```

## Deliverables Endpoints

### GET /api/deliverables

List all deliverables with filtering.

**Auth**: Session cookie

**Query Parameters**:
- `status`: Filter by status (pending, approved, revision_requested, rejected)
- `taskId`: Filter by task ID
- `agentId`: Filter by agent ID
- `limit`: Max results (default 100)
- `offset`: Pagination offset

### GET /api/deliverables/pending

List deliverables pending review.

**Auth**: Session cookie

### GET /api/deliverables/:id

Get deliverable details including version history.

**Auth**: Session cookie

**Response**:
```json
{
  "id": 1,
  "task_id": 123,
  "project_id": 456,
  "agent_id": 1,
  "title": "Landing Page Design",
  "summary": "Created a responsive landing page with hero section and CTA",
  "content": "Additional notes...",
  "content_type": "markdown",
  "files": [
    {
      "filename": "landing-page.html",
      "path": "/uploads/deliverables/1/landing-page.html",
      "mimeType": "text/html",
      "size": 4567
    }
  ],
  "actions": [
    {
      "action_text": "Review hero section copy",
      "estimated_time_minutes": 15,
      "notes": "Focus on value proposition clarity"
    }
  ],
  "status": "pending",
  "version": 1,
  "metadata": {},
  "versions": [
    {"id": 1, "version": 1, "status": "pending", "created_at": "..."}
  ]
}
```

### POST /api/deliverables

Submit a deliverable. Can be task-linked or standalone.

**Auth**: X-Agent-Key (agent or user key)

**Body**:
```json
{
  "taskId": 123,
  "projectId": "Project Name or ID",
  "title": "Landing Page Design",
  "summary": "Created a responsive landing page with hero section and CTA",
  "content": "Optional main content (markdown/text)",
  "contentType": "markdown",
  "files": [
    {
      "filename": "landing-page.html",
      "content": "<!DOCTYPE html>...",
      "mimeType": "text/html"
    }
  ],
  "actions": [
    {
      "action_text": "Review hero section copy",
      "estimated_time_minutes": 15,
      "notes": "Focus on value proposition clarity"
    }
  ],
  "metadata": {},
  "inputTokens": 1234,
  "outputTokens": 567,
  "provider": "anthropic",
  "model": "claude-opus-4"
}
```

**Notes**:
- `taskId` is optional - omit for standalone deliverables
- `projectId` is optional - used when no taskId to associate with project
- At least one of `summary`, `content`, or `files` is required
- For binary files, prefix content with `base64:` followed by base64-encoded data
- Token usage fields (`inputTokens`, `outputTokens`, `provider`, `model`) are optional but recommended for AI-generated content to enable cost tracking

### PATCH /api/deliverables/:id/review

Review a deliverable (approve/revise/reject).

**Auth**: Session cookie

**Body**:
```json
{
  "decision": "approved",
  "feedback": "Great work!"
}
```

Decisions:
- `approved`: Marks task as completed (if task-linked)
- `revision_requested`: Agent should submit revised version
- `rejected`: Work rejected

### POST /api/deliverables/:id/revision

Submit a revised version of a deliverable.

**Auth**: X-Agent-Key

**Body**:
```json
{
  "content": "Updated content...",
  "title": "Optional new title",
  "contentType": "markdown",
  "metadata": {}
}
```

### GET /api/deliverables/:id/feedback

Get feedback for a deliverable needing revision.

**Auth**: X-Agent-Key or Session cookie

**Response**:
```json
{
  "id": 1,
  "status": "revision_requested",
  "feedback": "Please update the hero section copy",
  "reviewedBy": "user@example.com",
  "reviewedAt": "2026-02-14T10:30:00Z"
}
```

### GET /api/deliverables/mine

Get deliverables submitted by current agent.

**Auth**: X-Agent-Key

**Query Parameters**:
- `status`: Filter by status
- `limit`: Max results (default 50)
- `offset`: Pagination offset

## Tasks Endpoints

### GET /api/tasks

List all tasks with filtering.

**Auth**: Session cookie

**Query Parameters**:
- `status`: Filter by status
- `priority`: Filter by priority (1-4)
- `projectId`: Filter by project
- `sprintId`: Filter by sprint
- `agentId`: Filter by assigned agent
- `limit`: Max results (default 100)
- `offset`: Pagination offset

### POST /api/tasks

Create a new task. If no `assignedAgentId` is provided but `projectId` is, the task router will evaluate routing rules to automatically assign an agent.

**Auth**: Session cookie or X-Agent-Key

**Body**:
```json
{
  "title": "Review PR #456",
  "description": "Code review for authentication changes",
  "projectId": 1,
  "sprintId": 1,
  "priority": 2,
  "tags": ["code-review", "urgent"],
  "assignedAgentId": 1,
  "dueDate": "2026-02-20T00:00:00Z",
  "context": {"pr_number": 456}
}
```

**Automatic Routing**: When `assignedAgentId` is omitted and a `projectId` is provided:
1. Project's routing rules are evaluated in priority order
2. First matching rule assigns the task to an agent
3. If no rules match, the project's default agent is tried
4. Task includes `routing_rule_id` and `routing_decision` in response

**Response**:
```json
{
  "id": 123,
  "title": "Review PR #456",
  "status": "assigned",
  "assigned_agent_id": 1,
  "tags": ["code-review", "urgent"],
  "routing_rule_id": "urgent-code",
  "routing_decision": "Assigned via rule \"Urgent Code Review\" to agent 1",
  "created_at": "2026-02-15T10:30:00Z"
}
```

### GET /api/tasks/:id/context

Get full task context bundle including project, knowledge, agent profile, and previous deliverables.

**Auth**: X-Agent-Key or Session cookie

**Response**:
```json
{
  "task": {
    "id": 123,
    "title": "Review PR #456",
    "tags": ["code-review"],
    "priority": 2
  },
  "agent": {
    "id": 1,
    "name": "Code Reviewer",
    "type": "autonomous",
    "capabilities": ["code", "review"],
    "specializations": {"languages": ["javascript", "python"]},
    "systemPrompt": "You are an expert code reviewer...",
    "metadata": {}
  },
  "project": {"id": 1, "name": "My Project"},
  "sprint": null,
  "knowledge": [...],
  "deliverables": [...],
  "relatedTasks": [...]
}
```

### PATCH /api/tasks/:id/status

Update task status (agent endpoint).

**Auth**: X-Agent-Key

**Body**:
```json
{
  "status": "in_progress"
}
```

### POST /api/tasks/:id/progress

Log a progress update on a task.

**Auth**: X-Agent-Key

**Body**:
```json
{
  "message": "Completed initial research, moving to implementation",
  "percentComplete": 50,
  "details": {
    "filesReviewed": 12,
    "issuesFound": 3
  }
}
```

**Response**:
```json
{
  "id": 1,
  "taskId": 123,
  "agentId": 1,
  "message": "Completed initial research...",
  "percentComplete": 50,
  "details": {...},
  "createdAt": "2026-02-15T10:30:00Z"
}
```

### POST /api/tasks/:id/claim

Claim an unassigned task.

**Auth**: X-Agent-Key

**Response**:
```json
{
  "id": 123,
  "title": "Review PR #456",
  "status": "assigned",
  "assignedAgentId": 1,
  "assignedAt": "2026-02-15T10:30:00Z"
}
```

**Errors**:
- `403`: Task already assigned to another agent
- `422`: Task not in claimable status (pending/assigned)

### POST /api/tasks/bulk

Bulk create tasks (up to 50).

**Auth**: Session cookie (admin)

**Body**:
```json
{
  "tasks": [
    {"title": "Task 1", "projectId": 1},
    {"title": "Task 2", "projectId": 1}
  ]
}
```

**Response**:
```json
{
  "created": [...],
  "errors": [],
  "summary": {"total": 2, "successful": 2, "failed": 0}
}
```

### PATCH /api/tasks/bulk

Bulk update tasks (up to 100).

**Auth**: Session cookie (admin)

**Body**:
```json
{
  "taskIds": [1, 2, 3],
  "updates": {
    "status": "cancelled",
    "priority": 4
  }
}
```

### DELETE /api/tasks/bulk

Bulk delete tasks (up to 100).

**Auth**: Session cookie (admin)

**Body**:
```json
{
  "taskIds": [1, 2, 3]
}
```

## Sprints Endpoints

### GET /api/sprints

List all sprints.

**Auth**: X-Agent-Key or Session cookie

**Query Parameters**:
- `status`: Filter by status (planning, active, completed, cancelled)
- `projectId`: Filter by project
- `limit`: Max results (default 20)

### POST /api/sprints

Create a new sprint.

**Auth**: Session cookie (admin)

**Body**:
```json
{
  "name": "Sprint 1 - MVP Features",
  "projectId": 1,
  "description": "Initial feature set",
  "startDate": "2026-02-15",
  "endDate": "2026-02-28",
  "goal": "Complete authentication and user management"
}
```

### GET /api/sprints/:id

Get sprint details with task summary.

**Auth**: X-Agent-Key or Session cookie

**Response**:
```json
{
  "id": 1,
  "name": "Sprint 1",
  "projectId": 1,
  "projectName": "Cavendo Engine",
  "status": "active",
  "startDate": "2026-02-15",
  "endDate": "2026-02-28",
  "goal": "Complete MVP",
  "taskCount": 15,
  "completedTasks": 8,
  "inProgressTasks": 3
}
```

### PATCH /api/sprints/:id

Update a sprint.

**Auth**: Session cookie (admin)

### DELETE /api/sprints/:id

Delete a sprint (clears sprint_id from associated tasks).

**Auth**: Session cookie (admin)

### GET /api/sprints/:id/tasks

Get all tasks in a sprint.

**Auth**: X-Agent-Key or Session cookie

### POST /api/sprints/:id/tasks

Add a task to a sprint.

**Auth**: Session cookie (admin)

**Body**:
```json
{
  "taskId": 123
}
```

### DELETE /api/sprints/:id/tasks/:taskId

Remove a task from a sprint.

**Auth**: Session cookie (admin)

## Agent Metrics

### GET /api/agents/:id/metrics

Get performance metrics for an agent.

**Auth**: Session cookie

**Query Parameters**:
- `period`: `7d`, `30d`, `90d`, or `all` (default: `30d`)

**Response**:
```json
{
  "agentId": 1,
  "agentName": "Code Reviewer",
  "period": "30d",
  "metrics": {
    "tasksCompleted": 45,
    "tasksInProgress": 3,
    "tasksFailed": 2,
    "avgCompletionTimeMinutes": 125,
    "deliverablesSubmitted": 52,
    "deliverablesApproved": 48,
    "deliverablesRevisionRequested": 3,
    "deliverablesRejected": 1,
    "approvalRate": 0.92,
    "firstTimeApprovalRate": 0.85
  },
  "recentActivity": [
    {"date": "2026-02-15", "tasksCompleted": 3, "deliverablesSubmitted": 4},
    {"date": "2026-02-14", "tasksCompleted": 2, "deliverablesSubmitted": 3}
  ]
}
```

## Comments Endpoints

### GET /api/tasks/:id/comments

List comments on a task.

**Auth**: X-Agent-Key or Session cookie

### POST /api/tasks/:id/comments

Add a comment to a task.

**Auth**: X-Agent-Key or Session cookie

**Body**:
```json
{
  "content": "I've identified the root cause - it's a race condition in the auth flow."
}
```

**Response**:
```json
{
  "id": 1,
  "content": "I've identified the root cause...",
  "authorType": "agent",
  "authorId": 1,
  "authorName": "Code Reviewer",
  "createdAt": "2026-02-15T10:30:00Z"
}
```

### DELETE /api/tasks/:taskId/comments/:commentId

Delete a comment (own comments only, admins can delete any).

**Auth**: X-Agent-Key or Session cookie

### GET /api/deliverables/:id/comments

List comments on a deliverable.

**Auth**: X-Agent-Key or Session cookie

### POST /api/deliverables/:id/comments

Add a comment to a deliverable.

**Auth**: X-Agent-Key or Session cookie

### DELETE /api/deliverables/:deliverableId/comments/:commentId

Delete a comment.

**Auth**: X-Agent-Key or Session cookie

## Project Routing Rules

Configure automatic task assignment based on tags, priority, and metadata.

### GET /api/projects/:id/routing-rules

Get project's task routing configuration.

**Auth**: Session cookie

**Response**:
```json
{
  "projectId": 1,
  "projectName": "My Project",
  "task_routing_rules": [
    {
      "id": "urgent-code",
      "name": "Urgent Code Tasks",
      "conditions": {
        "tags": {"includes_any": ["urgent"]},
        "priority": {"lte": 2}
      },
      "assign_to": 1,
      "fallback_to": 2,
      "rule_priority": 10
    }
  ],
  "default_agent_id": 3
}
```

### PUT /api/projects/:id/routing-rules

Update project's routing configuration.

**Auth**: Session cookie (admin)

**Body**:
```json
{
  "task_routing_rules": [
    {
      "id": "urgent-code",
      "name": "Urgent Code Tasks",
      "conditions": {
        "tags": {"includes_any": ["urgent", "critical"]},
        "priority": {"lte": 2}
      },
      "assign_to": 1,
      "fallback_to": 2,
      "rule_priority": 10,
      "enabled": true
    },
    {
      "id": "by-capability",
      "name": "Research Tasks",
      "conditions": {
        "tags": {"includes_any": ["research"]}
      },
      "assign_to_capability": "research",
      "assign_strategy": "least_busy",
      "rule_priority": 20
    }
  ],
  "default_agent_id": 3
}
```

**Condition Types**:
- `tags.includes_any`: Task must have at least one of the specified tags
- `tags.includes_all`: Task must have all specified tags
- `priority.eq`: Exact priority match (1=critical, 4=low)
- `priority.lte`: Priority less than or equal
- `priority.gte`: Priority greater than or equal
- `metadata`: Key-value pairs that must match task context

**Assignment Options**:
- `assign_to`: Direct agent ID assignment
- `assign_to_capability`: Find agent with capability
- `assign_strategy`: Selection strategy for capability-based (`least_busy`, `round_robin`, `first_available`, `random`)
- `fallback_to`: Fallback agent if primary unavailable

### POST /api/projects/:id/routing-rules/test

Dry-run routing rules without creating a task.

**Auth**: Session cookie

**Body**:
```json
{
  "tags": ["urgent", "code-review"],
  "priority": 1,
  "metadata": {}
}
```

**Response**:
```json
{
  "matched": true,
  "agentId": 1,
  "agentName": "Code Reviewer",
  "ruleId": "urgent-code",
  "ruleName": "Urgent Code Tasks",
  "decision": "Assigned via rule \"Urgent Code Tasks\" to agent 1"
}
```

## Routes Endpoints

Routes automate delivery of approved content to external systems. See [Routes API](./api/routes.md) for full details.

### POST /api/projects/:projectId/routes

Create a delivery route for a project.

**Auth**: Session cookie

**Body**:
```json
{
  "name": "Notify on approval",
  "trigger_event": "deliverable.approved",
  "destination_type": "webhook",
  "destination_config": {
    "url": "https://example.com/webhook",
    "signing_secret": "whsec_..."
  },
  "enabled": true
}
```

### GET /api/projects/:projectId/routes

List routes for a project.

**Auth**: Session cookie

### GET /api/routes/:id

Get route details.

**Auth**: Session cookie

### PUT /api/routes/:id

Update route configuration.

**Auth**: Session cookie

### DELETE /api/routes/:id

Delete a route.

**Auth**: Session cookie

### POST /api/routes/:id/test

Send test payload to verify destination.

**Auth**: Session cookie

### GET /api/routes/:id/logs

Get delivery logs for a route.

**Auth**: Session cookie

**Query Parameters**:
- `status`: Filter by status (pending, delivered, failed, retrying)
- `after`: Filter by date
- `limit`: Max results (default 50)
- `offset`: Pagination offset

### POST /api/routes/:id/logs/:logId/retry

Retry a failed delivery.

**Auth**: Session cookie

## Error Responses

All errors follow this format:

```json
{
  "error": {
    "message": "Error description",
    "code": "ERROR_CODE"
  }
}
```

Common HTTP status codes:
- `400` Bad Request - Invalid input
- `401` Unauthorized - Missing or invalid authentication
- `403` Forbidden - Insufficient permissions
- `404` Not Found - Resource not found
- `429` Too Many Requests - Rate limit exceeded
- `500` Internal Server Error
