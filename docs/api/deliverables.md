# Deliverables API

Submit work products and manage the review workflow.

## Endpoints Overview

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/deliverables` | User | List all deliverables |
| GET | `/api/deliverables/pending` | User | List pending review |
| GET | `/api/deliverables/:id` | User | Get deliverable details |
| GET | `/api/deliverables/:id/feedback` | User/Agent | Get revision feedback |
| PATCH | `/api/deliverables/:id/review` | User | Review deliverable |
| POST | `/api/deliverables` | Agent | Submit deliverable |
| POST | `/api/deliverables/:id/revision` | Agent | Submit revision |
| GET | `/api/deliverables/mine` | Agent | List own deliverables |
| GET | `/api/deliverables/:id/comments` | User/Agent | List comments |
| POST | `/api/deliverables/:id/comments` | User/Agent | Add comment |

---

## Deliverable Object

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Unique identifier |
| `task_id` | number | Associated task |
| `project_id` | number | Associated project |
| `agent_id` | number | Submitting agent |
| `submitted_by_user_id` | number | User ID (if submitted with user key) |
| `title` | string | Deliverable title |
| `summary` | string | Text description for Overview tab |
| `content` | string | The actual content |
| `content_type` | string | `markdown`, `html`, `json`, `text`, `code` |
| `files` | array | File attachments `[{filename, path, mimeType, size}]` |
| `actions` | array | Follow-up items `[{action_text, estimated_time_minutes, notes}]` |
| `status` | string | `pending`, `approved`, `revision_requested`, `revised`, `rejected` |
| `version` | number | Revision version |
| `parent_id` | number | Previous version ID (for revisions) |
| `feedback` | string | Reviewer feedback |
| `reviewed_by` | string | Reviewer email |
| `reviewed_at` | string | Review timestamp |
| `metadata` | object | Additional metadata |
| `input_tokens` | number | Input tokens used (AI-generated) |
| `output_tokens` | number | Output tokens used (AI-generated) |
| `provider` | string | AI provider (anthropic, openai, etc.) |
| `model` | string | Model used (claude-opus-4, gpt-4o, etc.) |
| `created_at` | string | Submission timestamp |

---

## List Deliverables

```http
GET /api/deliverables
```

**Authentication:** User

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | Filter by status |
| `taskId` | number | Filter by task |
| `agentId` | number | Filter by agent |
| `limit` | number | Results per page (default: 100) |
| `offset` | number | Pagination offset |

**Example:**

```bash
curl "http://localhost:3001/api/deliverables?status=pending" \
  -b cookies.txt
```

---

## List Pending Review

```http
GET /api/deliverables/pending
```

**Authentication:** User

Returns all deliverables awaiting review, sorted by submission time.

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": 3,
      "title": "Market Research Report",
      "status": "pending",
      "version": 1,
      "task_id": 5,
      "task_title": "Research competitor pricing",
      "project_id": 1,
      "project_name": "Market Analysis",
      "agent_id": 1,
      "agent_name": "Research Agent",
      "content_type": "markdown",
      "created_at": "2026-02-14T14:00:00.000Z"
    }
  ]
}
```

---

## Get Deliverable Details

```http
GET /api/deliverables/:id
```

**Authentication:** User

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 3,
    "title": "Market Research Report",
    "content": "## Executive Summary\n\nOur analysis shows...",
    "content_type": "markdown",
    "status": "pending",
    "version": 2,
    "parent_id": 2,
    "task_id": 5,
    "task_title": "Research competitor pricing",
    "task_description": "Analyze pricing strategies...",
    "project_id": 1,
    "project_name": "Market Analysis",
    "agent_id": 1,
    "agent_name": "Research Agent",
    "metadata": {
      "word_count": 1500,
      "sources": 12
    },
    "versions": [
      {"id": 3, "version": 2, "status": "pending", "created_at": "..."},
      {"id": 2, "version": 1, "status": "revision_requested", "created_at": "..."}
    ]
  }
}
```

---

## Get Revision Feedback

```http
GET /api/deliverables/:id/feedback
```

**Authentication:** User or Agent

Returns feedback for a deliverable that needs revision.

**Agent Example:**

```bash
curl -H "X-Agent-Key: cav_ak_..." \
  http://localhost:3001/api/deliverables/2/feedback
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 2,
    "status": "revision_requested",
    "feedback": "Please add more data sources and include competitor pricing tables.",
    "reviewedBy": "reviewer@company.com",
    "reviewedAt": "2026-02-14T15:00:00.000Z"
  }
}
```

> **Security:** Agents can only get feedback for their own deliverables.

---

## Review Deliverable

```http
PATCH /api/deliverables/:id/review
```

**Authentication:** User (reviewer/admin)

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `decision` | string | Yes | `approved`, `revision_requested`, `rejected` |
| `feedback` | string | Required for revision | Feedback for the agent |

**Example - Approve:**

```bash
curl -X PATCH http://localhost:3001/api/deliverables/3/review \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  -d '{
    "decision": "approved",
    "feedback": "Great work! The analysis is thorough."
  }'
```

**Example - Request Revision:**

```bash
curl -X PATCH http://localhost:3001/api/deliverables/3/review \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  -d '{
    "decision": "revision_requested",
    "feedback": "Please add competitor pricing tables and expand the recommendations section."
  }'
```

**Example - Reject:**

```bash
curl -X PATCH http://localhost:3001/api/deliverables/3/review \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  -d '{
    "decision": "rejected",
    "feedback": "This doesn'\''t meet the requirements. The task needs to be reassigned."
  }'
```

**Webhook Events:**
- `deliverable.approved` - Sent when approved
- `deliverable.revision_requested` - Sent when revision needed
- `deliverable.rejected` - Sent when rejected

**Delivery Routes:**
When a deliverable is reviewed, any matching [delivery routes](./routes.md) for the project will automatically dispatch the content to configured destinations (webhooks, email, etc.).

---

## Submit Deliverable (Agent)

```http
POST /api/deliverables
```

**Authentication:** Agent

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `taskId` | number | No | Task ID (required if no projectId) |
| `projectId` | number/string | No | Project ID or name (for standalone deliverables) |
| `title` | string | Yes | Deliverable title |
| `summary` | string | No | Text description for Overview tab |
| `content` | string | No | Main content (required if no files) |
| `contentType` | string | No | `markdown` (default), `html`, `json`, `text`, `code` |
| `files` | array | No | File attachments `[{filename, content, mimeType}]` |
| `actions` | array | No | Follow-up items `[{action_text, estimated_time_minutes, notes}]` |
| `metadata` | object | No | Additional metadata |
| `inputTokens` | number | No | Input tokens used (for AI-generated content) |
| `outputTokens` | number | No | Output tokens used (for AI-generated content) |
| `provider` | string | No | AI provider (anthropic, openai, etc.) |
| `model` | string | No | Model used (claude-opus-4, gpt-4o, etc.) |

> **Note:** Either `taskId` or `projectId` should be provided. Standalone deliverables (without task) can be linked directly to a project.

> **Token Usage:** When submitting AI-generated content, include token usage for cost tracking. This enables analytics on AI consumption across projects and agents.

**Example:**

```bash
curl -X POST http://localhost:3001/api/deliverables \
  -H "X-Agent-Key: cav_ak_..." \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": 5,
    "title": "Market Research Report",
    "content": "## Executive Summary\n\nOur comprehensive analysis of competitor pricing...",
    "contentType": "markdown",
    "metadata": {
      "word_count": 1500,
      "sources": 12,
      "confidence": 0.92
    }
  }'
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 3,
    "task_id": 5,
    "title": "Market Research Report",
    "status": "pending",
    "version": 1,
    "created_at": "2026-02-14T14:00:00.000Z"
  }
}
```

> **Security:** Agents can only submit deliverables for tasks assigned to them.

> **Side Effect:** The task status is automatically updated to `review`.

---

## Submit Revision (Agent)

```http
POST /api/deliverables/:id/revision
```

**Authentication:** Agent

Submit a revised version of a deliverable that was marked for revision.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | No | New title (default: previous title) |
| `content` | string | Yes | The revised content |
| `contentType` | string | No | Content type |
| `metadata` | object | No | Additional metadata |

**Example:**

```bash
curl -X POST http://localhost:3001/api/deliverables/2/revision \
  -H "X-Agent-Key: cav_ak_..." \
  -H "Content-Type: application/json" \
  -d '{
    "content": "## Executive Summary (Revised)\n\nBased on feedback, I'\''ve added competitor pricing tables...",
    "metadata": {
      "word_count": 2100,
      "sources": 18,
      "revision_notes": "Added pricing tables and expanded recommendations"
    }
  }'
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 3,
    "task_id": 5,
    "version": 2,
    "parent_id": 2,
    "status": "pending"
  }
}
```

> **Security:**
> - Agents can only revise their own deliverables
> - Only deliverables with `revision_requested` status can be revised

---

## List Own Deliverables (Agent)

```http
GET /api/deliverables/mine
```

**Authentication:** Agent

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | Filter by status |
| `limit` | number | Results per page (default: 50) |
| `offset` | number | Pagination offset |

**Example:**

```bash
curl -H "X-Agent-Key: cav_ak_..." \
  "http://localhost:3001/api/deliverables/mine?status=revision_requested"
```

---

## Review Workflow

```
Agent submits ──▶ pending (v1)
                     │
         ┌───────────┼───────────┐
         │           │           │
    (approved)  (revision)  (rejected)
         │           │           │
         ▼           │           ▼
   Task completed    │      Task assigned
                     │
                     ▼
              v1 → revised
              task → assigned
                     │
                     ▼
           Agent or Dispatcher submits v2
           (parent_id → v1)
                     │
                     ▼
                 pending (v2)
                     │
                   (repeat)
```

### Deliverable Statuses

| Status | Description |
|--------|-------------|
| `pending` | Awaiting human review |
| `approved` | Accepted — task marked completed |
| `revision_requested` | Needs changes — feedback provided |
| `revised` | Superseded by a newer version |
| `rejected` | Not accepted — task returned to assigned |

### Version Chain

When a revision is submitted (via API or auto-executed by the dispatcher), the system:
1. Creates a new deliverable with `version = N+1` and `parent_id` pointing to the previous version
2. Updates the previous deliverable's status to `revised`
3. The GET `/api/deliverables/:id` response includes a `versions` array with the full history

```
v1 (revised) ← v2 (revised) ← v3 (pending)
```

### Auto-Execution of Revisions

When a task is sent back for revision and the assigned agent has `execution_mode = 'auto'`, the Task Dispatcher will automatically:
1. Detect the task is back in `assigned` status
2. Gather context including the previous deliverable and reviewer feedback
3. Re-execute the task via the AI provider
4. Create a new deliverable linked to the previous version

**Best Practices:**
1. Include clear feedback when requesting revisions — it's included in the AI prompt for auto-executed revisions
2. Track version history for complex tasks
3. Use metadata to capture quality metrics
4. Set up webhooks to notify agents of decisions
