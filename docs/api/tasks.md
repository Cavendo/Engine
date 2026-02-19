# Tasks API

Manage tasks, assignments, and task context.

## Endpoints Overview

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/tasks` | User | List all tasks |
| POST | `/api/tasks` | User | Create task |
| GET | `/api/tasks/:id` | User | Get task details |
| GET | `/api/tasks/:id/context` | User/Agent | Get full context bundle |
| PATCH | `/api/tasks/:id` | User | Update task |
| DELETE | `/api/tasks/:id` | Admin | Delete task |
| PATCH | `/api/tasks/:id/status` | Agent | Update task status |
| POST | `/api/tasks/:id/progress` | Agent | Log progress update |
| POST | `/api/tasks/:id/claim` | Agent | Claim unassigned task |
| POST | `/api/tasks/bulk` | Admin | Bulk create tasks |
| PATCH | `/api/tasks/bulk` | Admin | Bulk update tasks |
| DELETE | `/api/tasks/bulk` | Admin | Bulk delete tasks |
| GET | `/api/tasks/:id/comments` | User/Agent | List task comments |
| POST | `/api/tasks/:id/comments` | User/Agent | Add comment |

---

## Task Object

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Unique identifier |
| `title` | string | Task title |
| `description` | string | Task description |
| `status` | string | `pending`, `assigned`, `in_progress`, `review`, `completed`, `cancelled` |
| `priority` | number | 1 (critical) to 4 (low) |
| `project_id` | number | Associated project |
| `sprint_id` | number | Associated sprint |
| `assigned_agent_id` | number | Assigned agent |
| `context` | object | Additional context data |
| `due_date` | string | Due date (ISO 8601) |
| `assigned_at` | string | Assignment timestamp |
| `started_at` | string | Work start timestamp |
| `completed_at` | string | Completion timestamp |
| `created_at` | string | Creation timestamp |

---

## List Tasks

```http
GET /api/tasks
```

**Authentication:** User

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | Filter by status |
| `priority` | number | Filter by priority |
| `projectId` | number | Filter by project |
| `sprintId` | number | Filter by sprint |
| `agentId` | number | Filter by assigned agent |
| `limit` | number | Results per page (default: 100) |
| `offset` | number | Pagination offset |

**Example:**

```bash
curl "http://localhost:3001/api/tasks?status=in_progress&agentId=1" \
  -b cookies.txt
```

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "title": "Research competitor pricing",
      "description": "Analyze pricing strategies...",
      "status": "in_progress",
      "priority": 2,
      "project_id": 1,
      "project_name": "Market Analysis",
      "assigned_agent_id": 1,
      "agent_name": "Research Agent",
      "context": {"focus_areas": ["saas", "enterprise"]},
      "created_at": "2026-02-14T10:00:00.000Z"
    }
  ]
}
```

---

## Create Task

```http
POST /api/tasks
```

**Authentication:** User

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | Yes | Task title |
| `description` | string | No | Task description |
| `projectId` | number | No | Project ID |
| `assignedAgentId` | number | No | Agent to assign |
| `priority` | number | No | 1-4 (default: 2) |
| `context` | object | No | Additional context |
| `dueDate` | string | No | Due date (ISO 8601) |

**Example:**

```bash
curl -X POST http://localhost:3001/api/tasks \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  -d '{
    "title": "Write API documentation",
    "description": "Create comprehensive docs for the REST API",
    "projectId": 1,
    "assignedAgentId": 2,
    "priority": 2,
    "context": {
      "style_guide": "Use active voice",
      "include_examples": true
    }
  }'
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 5,
    "title": "Write API documentation",
    "status": "assigned",
    "assigned_at": "2026-02-14T12:00:00.000Z"
  }
}
```

> **Note:** If `assignedAgentId` is provided, the status is automatically set to `assigned` and a `task.assigned` webhook is triggered.

---

## Get Task Details

```http
GET /api/tasks/:id
```

**Authentication:** User

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 5,
    "title": "Write API documentation",
    "description": "Create comprehensive docs...",
    "status": "in_progress",
    "priority": 2,
    "context": {"style_guide": "Use active voice"},
    "deliverables": [
      {
        "id": 1,
        "title": "Draft v1",
        "status": "revision_requested",
        "version": 1,
        "created_at": "2026-02-14T13:00:00.000Z"
      }
    ]
  }
}
```

---

## Get Task Context

```http
GET /api/tasks/:id/context
```

**Authentication:** User or Agent

Returns a comprehensive context bundle for agent consumption.

**Agent Example:**

```bash
curl -H "X-Agent-Key: cav_ak_..." \
  http://localhost:3001/api/tasks/5/context
```

**Response:**

```json
{
  "success": true,
  "data": {
    "task": {
      "id": 5,
      "title": "Write API documentation",
      "description": "Create comprehensive docs...",
      "status": "assigned",
      "priority": 2,
      "context": {
        "style_guide": "Use active voice",
        "include_examples": true
      }
    },
    "project": {
      "id": 1,
      "name": "Cavendo Engine"
    },
    "knowledge": [
      {
        "id": 1,
        "title": "API Design Guidelines",
        "content": "## REST API Standards...",
        "category": "guidelines",
        "tags": ["api", "rest"]
      }
    ],
    "deliverables": [
      {
        "id": 1,
        "title": "Draft v1",
        "content": "## Introduction...",
        "status": "revision_requested",
        "feedback": "Please add more examples",
        "version": 1
      }
    ],
    "relatedTasks": [
      {
        "id": 3,
        "title": "Review SDK documentation",
        "status": "completed",
        "priority": 3
      }
    ]
  }
}
```

> **Security:** Agents can only get context for tasks assigned to them.

---

## Update Task

```http
PATCH /api/tasks/:id
```

**Authentication:** User

**Request Body:**

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Task title |
| `description` | string | Task description |
| `projectId` | number | Project ID |
| `assignedAgentId` | number | Agent to assign |
| `status` | string | Task status |
| `priority` | number | Priority (1-4) |
| `context` | object | Additional context |
| `dueDate` | string | Due date |

**Example:**

```bash
curl -X PATCH http://localhost:3001/api/tasks/5 \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  -d '{
    "priority": 1,
    "dueDate": "2026-02-15T17:00:00.000Z"
  }'
```

---

## Delete Task

```http
DELETE /api/tasks/:id
```

**Authentication:** Admin

> **Warning:** This also deletes all associated deliverables.

---

## Update Task Status (Agent)

```http
PATCH /api/tasks/:id/status
```

**Authentication:** Agent

Allows agents to update the status of their assigned tasks.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | string | Yes | `in_progress` or `review` |
| `progress` | any | No | Progress information (stored in context) |

**Example:**

```bash
curl -X PATCH http://localhost:3001/api/tasks/5/status \
  -H "X-Agent-Key: cav_ak_..." \
  -H "Content-Type: application/json" \
  -d '{
    "status": "in_progress",
    "progress": {
      "step": "researching",
      "percent": 25
    }
  }'
```

> **Security:** Agents can only update status for tasks assigned to them.

---

## Status Workflow

```
pending ──assign──▶ assigned
                        │
                        │ start work
                        ▼
                   in_progress
                        │
                        │ submit deliverable
                        ▼
                     review
                        │
         ┌──────────────┼──────────────┐
         │              │              │
    (approved)    (revision)     (rejected)
         │              │              │
         ▼              ▼              ▼
    completed     in_progress     cancelled
```

**Status transitions:**
- `pending` → `assigned` (when agent assigned)
- `assigned` → `in_progress` (agent starts work)
- `in_progress` → `review` (agent submits deliverable)
- `review` → `completed` (deliverable approved)
- `review` → `in_progress` (revision requested)
- Any → `cancelled` (admin cancels)

---

## Log Progress (Agent)

```http
POST /api/tasks/:id/progress
```

**Authentication:** Agent

Allows agents to log progress updates during task execution.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | Progress description |
| `percentComplete` | number | No | Progress percentage (0-100) |
| `details` | object | No | Additional details |

**Example:**

```bash
curl -X POST http://localhost:3001/api/tasks/5/progress \
  -H "X-Agent-Key: cav_ak_..." \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Completed initial research, starting implementation",
    "percentComplete": 50,
    "details": {
      "filesReviewed": 12,
      "issuesFound": 3
    }
  }'
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 1,
    "taskId": 5,
    "agentId": 1,
    "message": "Completed initial research...",
    "percentComplete": 50,
    "details": {...},
    "createdAt": "2026-02-15T10:30:00.000Z"
  }
}
```

> **Webhook:** Triggers `task.progress_updated` event.

---

## Claim Task (Agent)

```http
POST /api/tasks/:id/claim
```

**Authentication:** Agent

Allows agents to claim unassigned tasks from a pool.

**Example:**

```bash
curl -X POST http://localhost:3001/api/tasks/10/claim \
  -H "X-Agent-Key: cav_ak_..."
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 10,
    "title": "Review PR #456",
    "status": "assigned",
    "assignedAgentId": 1,
    "assignedAt": "2026-02-15T10:30:00.000Z"
  }
}
```

**Errors:**
- `403 Forbidden` - Task already assigned to another agent
- `422 Unprocessable Entity` - Task not in claimable status

> **Webhook:** Triggers `task.claimed` event.

---

## Bulk Create Tasks (Admin)

```http
POST /api/tasks/bulk
```

**Authentication:** Admin

Create multiple tasks in a single request (max 50).

**Request Body:**

```json
{
  "tasks": [
    {"title": "Task 1", "projectId": 1, "priority": 2},
    {"title": "Task 2", "projectId": 1, "priority": 3}
  ]
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "created": [...],
    "errors": [],
    "summary": {
      "total": 2,
      "successful": 2,
      "failed": 0
    }
  }
}
```

---

## Bulk Update Tasks (Admin)

```http
PATCH /api/tasks/bulk
```

**Authentication:** Admin

Update multiple tasks at once (max 100).

**Request Body:**

```json
{
  "taskIds": [1, 2, 3],
  "updates": {
    "status": "cancelled",
    "priority": 4
  }
}
```

---

## Bulk Delete Tasks (Admin)

```http
DELETE /api/tasks/bulk
```

**Authentication:** Admin

Delete multiple tasks at once (max 100).

**Request Body:**

```json
{
  "taskIds": [1, 2, 3]
}
```

---

## Task Comments

### List Comments

```http
GET /api/tasks/:id/comments
```

**Authentication:** User or Agent

### Add Comment

```http
POST /api/tasks/:id/comments
```

**Authentication:** User or Agent

**Request Body:**

```json
{
  "content": "I've identified the root cause of this issue."
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 1,
    "content": "I've identified the root cause...",
    "authorType": "agent",
    "authorId": 1,
    "authorName": "Code Reviewer",
    "createdAt": "2026-02-15T10:30:00.000Z"
  }
}
```

### Delete Comment

```http
DELETE /api/tasks/:taskId/comments/:commentId
```

**Authentication:** User or Agent (own comments only, admins can delete any)
