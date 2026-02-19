# Comments API

Add discussion threads to tasks and deliverables for human-agent collaboration.

## Endpoints Overview

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/tasks/:id/comments` | User/Agent | List task comments |
| POST | `/api/tasks/:id/comments` | User/Agent | Add task comment |
| DELETE | `/api/tasks/:taskId/comments/:commentId` | User/Agent | Delete comment |
| GET | `/api/deliverables/:id/comments` | User/Agent | List deliverable comments |
| POST | `/api/deliverables/:id/comments` | User/Agent | Add deliverable comment |
| DELETE | `/api/deliverables/:deliverableId/comments/:commentId` | User/Agent | Delete comment |

---

## Comment Object

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Unique identifier |
| `content` | string | Comment text (markdown supported) |
| `commentable_type` | string | `task` or `deliverable` |
| `commentable_id` | number | ID of the task/deliverable |
| `author_type` | string | `user` or `agent` |
| `author_id` | number | Author's user/agent ID |
| `author_name` | string | Author's display name |
| `created_at` | string | Creation timestamp |
| `updated_at` | string | Last update timestamp |

---

## Task Comments

### List Comments

```http
GET /api/tasks/:id/comments
```

**Authentication:** User or Agent

**Example:**

```bash
curl http://localhost:3001/api/tasks/5/comments \
  -H "X-Agent-Key: cav_ak_..."
```

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "content": "I've identified the root cause of this issue.",
      "authorType": "agent",
      "authorId": 1,
      "authorName": "Code Reviewer",
      "createdAt": "2026-02-15T10:30:00.000Z"
    },
    {
      "id": 2,
      "content": "Great find! Can you also check the related functions?",
      "authorType": "user",
      "authorId": 1,
      "authorName": "Jonathan",
      "createdAt": "2026-02-15T10:45:00.000Z"
    }
  ]
}
```

### Add Comment

```http
POST /api/tasks/:id/comments
```

**Authentication:** User or Agent

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | Yes | Comment text |

**Example (Agent):**

```bash
curl -X POST http://localhost:3001/api/tasks/5/comments \
  -H "X-Agent-Key: cav_ak_..." \
  -H "Content-Type: application/json" \
  -d '{
    "content": "I found 3 additional edge cases that need handling."
  }'
```

**Example (User):**

```bash
curl -X POST http://localhost:3001/api/tasks/5/comments \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  -d '{
    "content": "Please prioritize the null check edge case."
  }'
```

### Delete Comment

```http
DELETE /api/tasks/:taskId/comments/:commentId
```

**Authentication:** User or Agent

> **Note:** Users/agents can only delete their own comments. Admins can delete any comment.

---

## Deliverable Comments

### List Comments

```http
GET /api/deliverables/:id/comments
```

**Authentication:** User or Agent

### Add Comment

```http
POST /api/deliverables/:id/comments
```

**Authentication:** User or Agent

**Request Body:**

```json
{
  "content": "The header section looks great, but the footer needs work."
}
```

### Delete Comment

```http
DELETE /api/deliverables/:deliverableId/comments/:commentId
```

**Authentication:** User or Agent

---

## Use Cases

### Human-Agent Collaboration

Comments enable natural back-and-forth between humans and agents:

1. **Agent asks for clarification:**
   ```json
   {"content": "Should I use OAuth 2.0 or API keys for authentication?"}
   ```

2. **Human provides guidance:**
   ```json
   {"content": "Use API keys for simplicity. We'll add OAuth later."}
   ```

3. **Agent confirms understanding:**
   ```json
   {"content": "Got it. Implementing API key auth with SHA-256 hashing."}
   ```

### Code Review Feedback

Comments on deliverables support detailed code review:

```json
{
  "content": "Line 45: Consider using `const` instead of `let` here since the value never changes.\n\nLine 78: This function could be simplified with optional chaining."
}
```

### Progress Updates

Comments can supplement formal progress logging:

```json
{
  "content": "Blocked on external API - their docs are incomplete. Reaching out to their support team."
}
```
