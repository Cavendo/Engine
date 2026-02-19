# Agents API

Manage AI agents, their API keys, and webhook configurations.

## Endpoints Overview

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/agents` | User | List all agents |
| POST | `/api/agents` | Admin + CSRF | Register new agent |
| GET | `/api/agents/:id` | User | Get agent details |
| GET | `/api/agents/:id/metrics` | User | Get performance metrics |
| PATCH | `/api/agents/:id` | Admin + CSRF | Update agent |
| DELETE | `/api/agents/:id` | Admin + CSRF | Delete agent |
| POST | `/api/agents/:id/keys` | Admin + CSRF | Generate API key |
| DELETE | `/api/agents/:id/keys/:keyId` | Admin + CSRF | Revoke API key |
| PUT | `/api/agents/:id/owner` | Admin + CSRF | Link agent to user |
| PATCH | `/api/agents/:id/execution` | Admin + CSRF | Configure execution |
| POST | `/api/agents/:id/test-connection` | Admin + CSRF | Test provider connection |
| POST | `/api/agents/:id/execute` | Admin + CSRF | Execute task via provider |
| POST | `/api/agents/:id/webhook-secret` | Admin + CSRF | Generate webhook secret |
| GET | `/api/agents/me` | Agent | Get own details |
| GET | `/api/agents/me/tasks` | Agent | List assigned tasks |
| GET | `/api/agents/me/tasks/next` | Agent | Get next task |

> **Note:** All POST/PATCH/PUT/DELETE requests with session auth require the `X-CSRF-Token` header.

---

## List All Agents

```http
GET /api/agents
```

**Authentication:** User (any role)

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `capability` | string | Filter by capability (e.g., `research`) |
| `status` | string | Filter by status (`active`, `paused`, `disabled`) |
| `available` | boolean | If `true`, only agents with spare capacity |

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Research Agent",
      "type": "supervised",
      "description": "Performs market research",
      "capabilities": ["research", "analysis"],
      "status": "active",
      "webhook_url": "https://example.com/webhook",
      "webhook_events": ["task.assigned", "deliverable.approved"],
      "max_concurrent_tasks": 3,
      "created_at": "2026-02-14T10:00:00.000Z",
      "updated_at": "2026-02-14T10:00:00.000Z"
    }
  ]
}
```

---

## Register Agent

```http
POST /api/agents
```

**Authentication:** Admin

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Agent name |
| `type` | string | Yes | `autonomous`, `semi-autonomous`, `supervised` |
| `description` | string | No | Agent description |
| `capabilities` | string[] | No | List of capabilities |
| `maxConcurrentTasks` | number | No | Max simultaneous tasks (default: 5) |

**Example:**

```bash
curl -X POST http://localhost:3001/api/agents \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  -d '{
    "name": "Content Writer",
    "type": "supervised",
    "description": "Writes blog posts and documentation",
    "capabilities": ["writing", "editing", "seo"],
    "maxConcurrentTasks": 2
  }'
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 2,
    "name": "Content Writer",
    "type": "supervised",
    "description": "Writes blog posts and documentation",
    "capabilities": ["writing", "editing", "seo"],
    "status": "active",
    "max_concurrent_tasks": 2,
    "created_at": "2026-02-14T12:00:00.000Z"
  }
}
```

---

## Get Agent Details

```http
GET /api/agents/:id
```

**Authentication:** User

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "Research Agent",
    "type": "supervised",
    "capabilities": ["research"],
    "status": "active",
    "keys": [
      {
        "id": 1,
        "key_prefix": "cav_ak_a1b2",
        "name": "Production Key",
        "scopes": ["read", "write"],
        "last_used_at": "2026-02-14T11:30:00.000Z",
        "created_at": "2026-02-14T10:00:00.000Z"
      }
    ]
  }
}
```

---

## Get Agent Metrics

```http
GET /api/agents/:id/metrics
```

**Authentication:** User

Get performance metrics for an agent over a time period.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `period` | string | `7d`, `30d`, `90d`, or `all` (default: `30d`) |

**Example:**

```bash
curl "http://localhost:3001/api/agents/1/metrics?period=30d" \
  -b cookies.txt
```

**Response:**

```json
{
  "success": true,
  "data": {
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
}
```

**Metrics Description:**

| Metric | Description |
|--------|-------------|
| `tasksCompleted` | Total tasks completed in period |
| `tasksInProgress` | Currently in-progress tasks |
| `tasksFailed` | Tasks cancelled/failed in period |
| `avgCompletionTimeMinutes` | Average time from start to completion |
| `deliverablesSubmitted` | Total deliverables submitted |
| `deliverablesApproved` | Deliverables approved |
| `deliverablesRevisionRequested` | Deliverables needing revision |
| `deliverablesRejected` | Deliverables rejected |
| `approvalRate` | Approved / Total submitted |
| `firstTimeApprovalRate` | Approved on v1 / Total approved |

---

## Update Agent

```http
PATCH /api/agents/:id
```

**Authentication:** Admin

**Request Body:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Agent name |
| `type` | string | Agent type |
| `description` | string | Description |
| `capabilities` | string[] | Capabilities list |
| `status` | string | `active`, `inactive`, `suspended` |
| `webhookUrl` | string | Webhook endpoint URL |
| `webhookEvents` | string[] | Events to send |
| `maxConcurrentTasks` | number | Max simultaneous tasks |

**Example:**

```bash
curl -X PATCH http://localhost:3001/api/agents/1 \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  -d '{
    "status": "inactive",
    "maxConcurrentTasks": 5
  }'
```

---

## Delete Agent

```http
DELETE /api/agents/:id
```

**Authentication:** Admin

> **Warning:** This permanently deletes the agent and all associated API keys.

---

## Generate API Key

```http
POST /api/agents/:id/keys
```

**Authentication:** Admin

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | No | Key identifier |
| `scopes` | string[] | No | Permissions (default: `["read", "write"]`) |
| `expiresAt` | string | No | ISO 8601 expiration date |

**Example:**

```bash
curl -X POST http://localhost:3001/api/agents/1/keys \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  -d '{
    "name": "CI/CD Pipeline",
    "scopes": ["read", "write"],
    "expiresAt": "2027-01-01T00:00:00.000Z"
  }'
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 2,
    "apiKey": "cav_ak_x9y8z7...",
    "prefix": "cav_ak_x9y8",
    "name": "CI/CD Pipeline",
    "scopes": ["read", "write"],
    "expiresAt": "2027-01-01T00:00:00.000Z",
    "message": "Store this key securely - it cannot be retrieved again"
  }
}
```

> **Important:** The full key is only returned once. Store it securely!

---

## Revoke API Key

```http
DELETE /api/agents/:id/keys/:keyId
```

**Authentication:** Admin

The key is marked as revoked and will no longer authenticate.

---

## Generate Webhook Secret

```http
POST /api/agents/:id/webhook-secret
```

**Authentication:** Admin

Generates a new secret for the agent's inline webhook configuration.

**Response:**

```json
{
  "success": true,
  "data": {
    "secret": "whsec_abc123...",
    "message": "Store this secret securely"
  }
}
```

---

## Link Agent to User (Owner)

```http
PUT /api/agents/:id/owner
```

**Authentication:** Admin + CSRF

Link an agent to a user so "my tasks" queries return that user's tasks.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `userId` | number | Yes | User ID to link (null to unlink) |

**Example:**

```bash
curl -X PUT http://localhost:3001/api/agents/1/owner \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  -d '{"userId": 1}'
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "Research Agent",
    "owner_user_id": 1,
    "owner_name": "Jonathan Hart"
  }
}
```

---

## Configure Execution

```http
PATCH /api/agents/:id/execution
```

**Authentication:** Admin + CSRF

Configure AI provider settings for automatic task execution.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | string | No | `anthropic` or `openai` |
| `providerApiKey` | string | No | Provider API key (stored encrypted) |
| `providerModel` | string | No | Model ID (e.g., `claude-opus-4-20250514`) |
| `systemPrompt` | string | No | System prompt for the agent |
| `executionMode` | string | No | `manual`, `auto`, or `polling` |
| `maxTokens` | number | No | Max tokens per request (default: 4096) |
| `temperature` | number | No | Temperature 0-1 (default: 0.7) |

**Example:**

```bash
curl -X PATCH http://localhost:3001/api/agents/1/execution \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  -d '{
    "provider": "anthropic",
    "providerApiKey": "sk-ant-...",
    "providerModel": "claude-opus-4-20250514",
    "systemPrompt": "You are a code review expert...",
    "executionMode": "manual"
  }'
```

---

## Test Provider Connection

```http
POST /api/agents/:id/test-connection
```

**Authentication:** Admin + CSRF

Test the configured provider connection, or test a new configuration before saving.

**Request Body (optional):**

| Field | Type | Description |
|-------|------|-------------|
| `provider` | string | Provider to test |
| `apiKey` | string | API key to test |
| `model` | string | Model to test |

**Example (test saved config):**

```bash
curl -X POST http://localhost:3001/api/agents/1/test-connection \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt
```

**Example (test new config):**

```bash
curl -X POST http://localhost:3001/api/agents/1/test-connection \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  -d '{
    "provider": "anthropic",
    "apiKey": "sk-ant-...",
    "model": "claude-opus-4-20250514"
  }'
```

**Response:**

```json
{
  "success": true,
  "data": {
    "connected": true,
    "model": "claude-opus-4-20250514",
    "message": "Successfully connected to Anthropic API"
  }
}
```

---

## Execute Task

```http
POST /api/agents/:id/execute
```

**Authentication:** Admin + CSRF

Execute a task using the agent's configured AI provider.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `taskId` | number | Yes | Task ID to execute |

**Example:**

```bash
curl -X POST http://localhost:3001/api/agents/1/execute \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  -d '{"taskId": 123}'
```

**Response:**

```json
{
  "success": true,
  "data": {
    "deliverableId": 456,
    "content": "## Code Review\n\n...",
    "usage": {
      "inputTokens": 1234,
      "outputTokens": 567
    }
  }
}
```

---

## Get Own Details (Agent)

```http
GET /api/agents/me
```

**Authentication:** Agent (X-Agent-Key)

Returns the authenticated agent's information.

```bash
curl -H "X-Agent-Key: cav_ak_..." \
  http://localhost:3001/api/agents/me
```

---

## List Assigned Tasks (Agent)

```http
GET /api/agents/me/tasks
```

**Authentication:** Agent

Returns tasks based on key type:
- **Agent keys (`cav_ak_...`)**: Returns tasks assigned to this specific agent
- **User keys (`cav_uk_...`)**: Returns tasks assigned to agents owned by this user

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | Filter by status |
| `limit` | number | Results per page (default: 50) |
| `offset` | number | Pagination offset |

**Example:**

```bash
curl -H "X-Agent-Key: cav_ak_..." \
  "http://localhost:3001/api/agents/me/tasks?status=assigned"
```

---

## Get Next Task (Agent)

```http
GET /api/agents/me/tasks/next
```

**Authentication:** Agent

Returns the highest-priority pending/assigned task, respecting the concurrent task limit.

**Response (task available):**

```json
{
  "success": true,
  "data": {
    "task": {
      "id": 5,
      "title": "Write blog post",
      "description": "Create a post about AI agents",
      "status": "assigned",
      "priority": 2,
      "context": {}
    }
  }
}
```

**Response (no tasks):**

```json
{
  "success": true,
  "data": {
    "task": null,
    "reason": "no_tasks",
    "message": "No pending tasks assigned to this agent"
  }
}
```

**Response (at limit):**

```json
{
  "success": true,
  "data": {
    "task": null,
    "reason": "concurrent_limit_reached",
    "message": "Agent is at max concurrent tasks (3)"
  }
}
```
