# Sprints API

Organize tasks into sprints/milestones for better planning and tracking.

## Endpoints Overview

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/sprints` | User/Agent | List all sprints |
| POST | `/api/sprints` | Admin | Create sprint |
| GET | `/api/sprints/:id` | User/Agent | Get sprint details |
| PATCH | `/api/sprints/:id` | Admin | Update sprint |
| DELETE | `/api/sprints/:id` | Admin | Delete sprint |
| GET | `/api/sprints/:id/tasks` | User/Agent | List tasks in sprint |
| POST | `/api/sprints/:id/tasks` | Admin | Add task to sprint |
| DELETE | `/api/sprints/:id/tasks/:taskId` | Admin | Remove task from sprint |

---

## Sprint Object

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Unique identifier |
| `name` | string | Sprint name |
| `description` | string | Sprint description |
| `project_id` | number | Associated project |
| `status` | string | `planning`, `active`, `completed`, `cancelled` |
| `start_date` | string | Start date (YYYY-MM-DD) |
| `end_date` | string | End date (YYYY-MM-DD) |
| `goal` | string | Sprint goal/objective |
| `task_count` | number | Total tasks in sprint |
| `completed_tasks` | number | Completed tasks |
| `created_at` | string | Creation timestamp |
| `updated_at` | string | Last update timestamp |

---

## List Sprints

```http
GET /api/sprints
```

**Authentication:** User or Agent

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | Filter by status |
| `projectId` | number | Filter by project |
| `limit` | number | Results per page (default: 100) |

**Example:**

```bash
curl "http://localhost:3001/api/sprints?status=active&projectId=1" \
  -H "X-Agent-Key: cav_ak_..."
```

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Sprint 1 - MVP Features",
      "projectId": 1,
      "projectName": "Cavendo Engine",
      "status": "active",
      "startDate": "2026-02-15",
      "endDate": "2026-02-28",
      "goal": "Complete authentication and user management",
      "taskCount": 15,
      "completedTasks": 8
    }
  ]
}
```

---

## Create Sprint

```http
POST /api/sprints
```

**Authentication:** Admin

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Sprint name |
| `projectId` | number | Yes | Project ID |
| `description` | string | No | Description |
| `startDate` | string | No | Start date (YYYY-MM-DD) |
| `endDate` | string | No | End date (YYYY-MM-DD) |
| `goal` | string | No | Sprint goal |

**Example:**

```bash
curl -X POST http://localhost:3001/api/sprints \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  -d '{
    "name": "Sprint 2 - API Integration",
    "projectId": 1,
    "startDate": "2026-03-01",
    "endDate": "2026-03-14",
    "goal": "Complete third-party API integrations"
  }'
```

---

## Get Sprint Details

```http
GET /api/sprints/:id
```

**Authentication:** User or Agent

Returns sprint with task summary.

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "Sprint 1 - MVP Features",
    "projectId": 1,
    "projectName": "Cavendo Engine",
    "status": "active",
    "startDate": "2026-02-15",
    "endDate": "2026-02-28",
    "goal": "Complete authentication and user management",
    "taskCount": 15,
    "completedTasks": 8,
    "inProgressTasks": 4,
    "pendingTasks": 3
  }
}
```

---

## Update Sprint

```http
PATCH /api/sprints/:id
```

**Authentication:** Admin

**Request Body:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Sprint name |
| `description` | string | Description |
| `status` | string | Status |
| `startDate` | string | Start date |
| `endDate` | string | End date |
| `goal` | string | Sprint goal |

---

## Delete Sprint

```http
DELETE /api/sprints/:id
```

**Authentication:** Admin

> **Note:** Deleting a sprint clears `sprint_id` from associated tasks but does not delete the tasks themselves.

---

## List Tasks in Sprint

```http
GET /api/sprints/:id/tasks
```

**Authentication:** User or Agent

Returns all tasks associated with the sprint.

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": 5,
      "title": "Implement login API",
      "status": "completed",
      "priority": 1,
      "assignedAgentId": 1,
      "agentName": "Code Assistant"
    }
  ]
}
```

---

## Add Task to Sprint

```http
POST /api/sprints/:id/tasks
```

**Authentication:** Admin

**Request Body:**

```json
{
  "taskId": 123
}
```

---

## Remove Task from Sprint

```http
DELETE /api/sprints/:id/tasks/:taskId
```

**Authentication:** Admin

---

## Sprint Status Workflow

```
planning ──start──▶ active ──complete──▶ completed
    │                  │
    └────cancel────────┴────────▶ cancelled
```

**Status descriptions:**
- `planning` - Sprint is being planned (default)
- `active` - Sprint is in progress
- `completed` - Sprint finished successfully
- `cancelled` - Sprint was cancelled
