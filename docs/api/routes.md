# Routes API

Routes automate the delivery of approved content to external systems. When a deliverable is approved (or other trigger events occur), matching routes execute to push content to webhooks, email, or other destinations.

## Overview

Routes are project-scoped automation rules that:
- **Trigger** on events like `deliverable.approved`, `deliverable.submitted`, etc.
- **Filter** using optional conditions (tags, metadata)
- **Deliver** to webhooks or email (Cloud adds Slack, WordPress, Zapier)
- **Log** all delivery attempts with retry on failure

## Trigger Events

| Event | Fires When | Payload Includes | Primary Use |
|-------|------------|------------------|-------------|
| `deliverable.approved` | Reviewer approves a deliverable | `deliverable`, `project`, `taskId`, `reviewedBy` | Push approved content to CMS, S3, or external systems |
| `deliverable.submitted` | New deliverable created (initial submit or revision) | `deliverable`, `project`, `taskId`, `isRevision` | Notify reviewers of pending work |
| `deliverable.revision_requested` | Reviewer requests changes to a deliverable | `deliverable`, `project`, `taskId`, `feedback` | Notify agent/submitter to revise |
| `deliverable.rejected` | Reviewer rejects a deliverable | `deliverable`, `project`, `taskId`, `feedback` | Alert team of rejected content |
| `task.created` | New task is created via API or UI | `task`, `project` | Notify assigned agent, trigger automations |
| `task.assigned` | Task is assigned or reassigned to an agent (includes self-claim, bulk reassignment, and manual assignment) | `task`, `project`, `assignee`, `assigned_by` | Notify agent of new assignment |
| `task.completed` | Task status transitions to `completed` (also fires `task.status_changed`) | `task`, `project`, `assignee` | Notify on task completion |
| `task.status_changed` | Task status transitions (e.g. pending → in_progress, or task deleted) | `task`, `project`, `assignee`, `old_status`, `new_status` | Track progress, trigger workflows |
| `task.updated` | Task details are modified (title, description, priority, tags, due date, etc.) | `task`, `project`, `assignee` | Sync task changes to external trackers |
| `task.claimed` | Agent self-claims an unassigned task | `task`, `project`, `assignee` | Track agent workload, notify team |
| `task.progress_updated` | Agent reports progress on a task (percentage, notes) | `task`, `project`, `assignee`, `progress` | Dashboard updates, progress tracking |
| `task.routing_failed` | Automatic task routing found no matching agent | `task`, `project`, `reason` | Alert admins to unroutable tasks |
| `task.execution_failed` | Auto-executed agent task failed (API error, timeout, etc.) | `task`, `project`, `error`, `errorCategory` | Alert on broken agent pipelines |
| `task.overdue` | Task passes its `due_date` without completion (checked every dispatcher cycle, fires once per 24h per task) | `task`, `project`, `assignee`, `overdue_since` | Alert assignees/admins about late tasks |
| `review.completed` | A review action is taken on a deliverable (approve, reject, or request revision) | `deliverable`, `project`, `decision` | Audit trail, catch-all review hook |
| `agent.registered` | New agent is created (including auto-created human agents for new users) | `agent`, `linkedUser` (if human) | Admin notification, onboarding triggers |
| `agent.status_changed` | Agent status transitions (e.g. active → paused → disabled) | `agent`, `old_status`, `new_status` | Ops monitoring, team alerts |
| `project.created` | New project is created | `project`, `createdBy` | Onboarding automations, notify team |
| `project.knowledge_updated` | Project knowledge base entry is created, updated, or deleted | `knowledge`, `project`, `action` | Sync project knowledge to external systems |
| `knowledge.updated` | Knowledge base entry is created, updated, or deleted | `knowledge`, `project`, `action` | Sync knowledge to external systems |

**Note:** Events marked with `agent.status_changed` and `project.created` are system-level events with no project scope. They only match **global routes** (routes with no project). Events like `knowledge.updated` are project-scoped and also match global routes.

## Global Routes

Global routes have no project scope (`project_id` is null). They fire for:
- **System-level events** that aren't tied to a project (e.g. `agent.status_changed`, `project.created`)
- **All project events** — a global route for `deliverable.approved` fires across every project

Use global routes for cross-cutting concerns like admin notifications, audit logging, or org-wide integrations.

### Create Global Route

```
POST /api/routes/global
Authorization: Bearer <session_token>
Content-Type: application/json

{
  "name": "Alert on agent status change",
  "trigger_event": "agent.status_changed",
  "destination_type": "webhook",
  "destination_config": {
    "url": "https://example.com/ops-webhook"
  }
}
```

### List Global Routes

```
GET /api/routes/global
Authorization: Bearer <session_token>
```

## Destination Types

### Webhook

POST/PUT/PATCH to any URL with optional HMAC signing.

```json
{
  "destination_type": "webhook",
  "destination_config": {
    "url": "https://example.com/webhook",
    "method": "POST",
    "headers": {
      "X-Custom-Header": "value"
    },
    "signing_secret": "whsec_...",
    "timeout_ms": 10000,
    "payload_template": null
  }
}
```

When `signing_secret` is configured, requests include:
- `X-Cavendo-Signature`: HMAC-SHA256 hex digest
- `X-Cavendo-Timestamp`: Unix timestamp
- `X-Cavendo-Delivery-Id`: Unique delivery ID

### Email

Send emails via configured provider (SMTP, SendGrid, Mailjet, Postmark, AWS SES).

```json
{
  "destination_type": "email",
  "destination_config": {
    "to": ["reviewer@company.com"],
    "cc": [],
    "from_name": "Cavendo",
    "from_address": "notifications@example.com",
    "subject_template": "{{event_label}}: {{deliverable.title}}",
    "template": "deliverable_approved",
    "include_content_preview": true,
    "attach_files": false,
    "reply_to": "team@company.com"
  }
}
```

#### Dynamic Recipients

The `to` and `cc` fields support Handlebars templates that resolve against the event payload at dispatch time. This lets you route emails to the right person dynamically instead of hardcoding addresses.

```json
{
  "destination_type": "email",
  "destination_config": {
    "to": ["{{assignee.email}}"],
    "subject_template": "Task assigned: {{task.title}}"
  }
}
```

If a template resolves to an empty string or a value without `@`, it is silently filtered out. If all recipients are filtered, the delivery fails with "No valid email recipients after template resolution".

You can mix static and dynamic recipients:

```json
{
  "to": ["{{assignee.email}}", "admin@company.com"],
  "cc": ["{{assignee.email}}"]
}
```

See [Template Variables](#template-variables) below for the full reference of available `{{variables}}` per event type.

Built-in email templates:
- `deliverable_submitted` - New submission notification
- `deliverable_approved` - Approval confirmation
- `revision_requested` - Revision request with feedback
- `daily_digest` - Summary of activity (scheduled)

## API Endpoints

### Create Route

```
POST /api/projects/:projectId/routes
Authorization: Bearer <session_token>
Content-Type: application/json

{
  "name": "Notify on approval",
  "description": "Send webhook when deliverables are approved",
  "trigger_event": "deliverable.approved",
  "trigger_conditions": {
    "tags": {
      "includes_any": ["blog-post", "article"]
    }
  },
  "destination_type": "webhook",
  "destination_config": {
    "url": "https://example.com/webhook",
    "signing_secret": "whsec_..."
  },
  "retry_policy": {
    "max_retries": 3,
    "backoff_type": "exponential",
    "initial_delay_ms": 1000
  },
  "enabled": true
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "project_id": 1,
    "name": "Notify on approval",
    "trigger_event": "deliverable.approved",
    "destination_type": "webhook",
    "enabled": true,
    "created_at": "2026-02-15T10:00:00Z"
  }
}
```

### List Routes

```
GET /api/projects/:projectId/routes
Authorization: Bearer <session_token>
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Notify on approval",
      "trigger_event": "deliverable.approved",
      "destination_type": "webhook",
      "enabled": true,
      "success_count": 42,
      "failure_count": 2,
      "last_fired_at": "2026-02-15T14:30:00Z"
    }
  ]
}
```

### Get Route

```
GET /api/routes/:routeId
Authorization: Bearer <session_token>
```

### Update Route

```
PUT /api/routes/:routeId
Authorization: Bearer <session_token>
Content-Type: application/json

{
  "enabled": false
}
```

### Delete Route

```
DELETE /api/routes/:routeId
Authorization: Bearer <session_token>
```

### Test Route

Send a test payload to verify destination connectivity.

```
POST /api/routes/:routeId/test
Authorization: Bearer <session_token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "success": true,
    "message": "Test payload sent successfully",
    "response": {
      "status": 200,
      "body": "OK"
    }
  }
}
```

### Get Delivery Logs

```
GET /api/routes/:routeId/logs
Authorization: Bearer <session_token>
```

**Query Parameters:**
- `status` - Filter by status: `pending`, `delivered`, `failed`, `retrying`
- `after` - Filter by date (ISO 8601)
- `event_type` - Filter by trigger event
- `limit` - Results per page (default: 50)
- `offset` - Pagination offset

**Response:**
```json
{
  "success": true,
  "data": {
    "logs": [
      {
        "id": 1,
        "route_id": 1,
        "event_type": "deliverable.approved",
        "status": "delivered",
        "attempt_number": 1,
        "response_status": 200,
        "duration_ms": 245,
        "dispatched_at": "2026-02-15T14:30:00Z",
        "completed_at": "2026-02-15T14:30:00Z"
      }
    ],
    "pagination": {
      "total": 42,
      "limit": 50,
      "offset": 0
    }
  }
}
```

### Retry Failed Delivery

```
POST /api/routes/:routeId/logs/:logId/retry
Authorization: Bearer <session_token>
```

## Trigger Conditions

Optional filters to match specific events:

```json
{
  "trigger_conditions": {
    "tags": {
      "includes_any": ["blog-post"],
      "includes_all": ["published", "reviewed"]
    },
    "metadata": {
      "content_type": "markdown",
      "priority": "high"
    }
  }
}
```

- `tags.includes_any` - Match if deliverable has any of these tags
- `tags.includes_all` - Match only if deliverable has all these tags
- `metadata` - Match if deliverable metadata contains these key-value pairs

## Retry Policy

Configure automatic retry on failure:

```json
{
  "retry_policy": {
    "max_retries": 5,
    "backoff_type": "exponential",
    "initial_delay_ms": 1000
  }
}
```

**Backoff Types:**
- `exponential` - 1s → 2s → 4s → 8s → 16s
- `linear` - 1s → 2s → 3s → 4s → 5s
- `fixed` - 1s → 1s → 1s → 1s → 1s

## Webhook Payload

Default payload sent to webhooks:

```json
{
  "event": "deliverable.approved",
  "timestamp": "2026-02-15T14:30:00Z",
  "delivery_id": "del_abc123",
  "project": {
    "id": 1,
    "name": "Content Pipeline"
  },
  "deliverable": {
    "id": 456,
    "title": "Q1 Blog Post",
    "content": "...",
    "summary": "Analysis of Q1 trends...",
    "status": "approved",
    "files": [],
    "metadata": {},
    "submitted_by": { "id": 1, "name": "ContentBot" },
    "approved_by": { "id": 2, "name": "Jane Smith" },
    "approved_at": "2026-02-15T14:30:00Z"
  }
}
```

### Custom Payload Templates

Use Handlebars syntax to customize payloads:

```json
{
  "payload_template": "{ \"text\": \"New: {{deliverable.title}}\", \"author\": \"{{deliverable.submitted_by.name}}\" }"
}
```

## Template Variables

All Handlebars template fields (`to`, `cc`, `subject_template`, `payload_template`) can reference variables from the event payload. The available variables depend on which trigger event fired.

### Common Variables (All Events)

| Variable | Description |
|----------|-------------|
| `{{event}}` | Event type string (e.g., `deliverable.approved`) |
| `{{event_label}}` | Human-readable label (e.g., `Approved`) |
| `{{timestamp}}` | ISO 8601 timestamp |
| `{{project.id}}` | Project ID |
| `{{project.name}}` | Project name |

### Deliverable Events

Available on `deliverable.approved`, `deliverable.submitted`, `deliverable.revision_requested`, `deliverable.rejected`, `review.completed`.

| Variable | Description |
|----------|-------------|
| `{{deliverable.id}}` | Deliverable ID |
| `{{deliverable.title}}` | Title |
| `{{deliverable.summary}}` | Summary text |
| `{{deliverable.content}}` | Full content |
| `{{deliverable.content_type}}` | Content type (markdown, html, etc.) |
| `{{deliverable.status}}` | Current status |
| `{{deliverable.submitted_by.id}}` | Submitter agent ID |
| `{{deliverable.submitted_by.name}}` | Submitter agent name |
| `{{deliverable.approved_by.id}}` | Reviewer user ID (approval/rejection events only) |
| `{{deliverable.approved_by.name}}` | Reviewer name |
| `{{taskId}}` | Linked task ID (null for standalone) |
| `{{feedback}}` | Review feedback (revision/rejection events only) |
| `{{isRevision}}` | Boolean, true if this is a revision resubmit |
| `{{decision}}` | `approved`, `revision_requested`, or `rejected` (`review.completed` only) |

### Task Events

Available on `task.created`, `task.assigned`, `task.completed`, `task.status_changed`, `task.overdue`, `task.routing_failed`, `task.execution_failed`.

| Variable | Description |
|----------|-------------|
| `{{task.id}}` | Task ID |
| `{{task.title}}` | Title |
| `{{task.description}}` | Description |
| `{{task.status}}` | Current status |
| `{{task.priority}}` | Priority (1=critical, 4=low) |
| `{{task.due_date}}` | Due date |
| `{{task.assigned_agent_id}}` | Assigned agent ID |
| `{{task.assigned_agent_name}}` | Assigned agent name |

#### Assignee Info (Dynamic Email Recipients)

Available on `task.assigned`, `task.completed`, `task.status_changed`, and `task.overdue`. The `assignee` object includes the linked user's email when the agent has an `owner_user_id`.

| Variable | Description | Useful as email recipient? |
|----------|-------------|---------------------------|
| **`{{assignee.email}}`** | **Assigned agent's linked user email** | **Yes** |
| `{{assignee.name}}` | Agent display name | No |
| `{{assignee.userName}}` | Linked user's display name | No |
| `{{assignee.executionMode}}` | `human`, `auto`, or `external` | No |
| `{{agent.email}}` | Alias for `{{assignee.email}}` | **Yes** |

**Example:** Email the assignee when a task is assigned:

```json
{
  "name": "Email on Task Assignment",
  "trigger_event": "task.assigned",
  "destination_type": "email",
  "destination_config": {
    "to": ["{{assignee.email}}"],
    "subject_template": "You've been assigned: {{task.title}}"
  }
}
```

#### Status Change Variables

Available on `task.status_changed` only:

| Variable | Description |
|----------|-------------|
| `{{old_status}}` | Previous status |
| `{{new_status}}` | New status |

#### Overdue Variables

Available on `task.overdue` only:

| Variable | Description |
|----------|-------------|
| `{{overdue_since}}` | The due date that was missed |

#### Routing/Execution Failure Variables

| Variable | Event | Description |
|----------|-------|-------------|
| `{{reason}}` | `task.routing_failed` | Why routing found no agent |
| `{{error}}` | `task.execution_failed` | Error message |
| `{{errorCategory}}` | `task.execution_failed` | Classified error type |
| `{{agentName}}` | `task.execution_failed` | Name of failed agent |

### Agent Events

| Variable | Event | Description |
|----------|-------|-------------|
| `{{agent.id}}` | `agent.registered`, `agent.status_changed` | Agent ID |
| `{{agent.name}}` | Both | Agent display name |
| `{{agent.type}}` | Both | Agent type |
| `{{agent.status}}` | Both | Current status |
| `{{linkedUser.email}}` | `agent.registered` (user-creation only) | Linked user's email |
| `{{linkedUser.name}}` | `agent.registered` (user-creation only) | Linked user's name |
| `{{old_status}}` | `agent.status_changed` | Previous status |
| `{{new_status}}` | `agent.status_changed` | New status |

### Other Events

| Variable | Event | Description |
|----------|-------|-------------|
| `{{createdBy}}` | `project.created` | Creator's name or email |
| `{{description}}` | `project.created` | Project description |
| `{{knowledge.id}}` | `knowledge.updated` | Knowledge entry ID |
| `{{knowledge.title}}` | `knowledge.updated` | Entry title |
| `{{knowledge.category}}` | `knowledge.updated` | Category |
| `{{action}}` | `knowledge.updated` | `created`, `updated`, or `deleted` |

## Email Configuration

Configure email provider via environment variables:

```bash
# Provider selection
EMAIL_PROVIDER=smtp  # smtp, sendgrid, mailjet, postmark, ses

# SMTP
EMAIL_SMTP_HOST=smtp.example.com
EMAIL_SMTP_PORT=587
EMAIL_SMTP_USER=user
EMAIL_SMTP_PASS=password
EMAIL_SMTP_SECURE=false

# SendGrid
EMAIL_SENDGRID_API_KEY=SG.xxx

# Mailjet
EMAIL_MAILJET_API_KEY=xxx
EMAIL_MAILJET_SECRET_KEY=xxx

# Postmark
EMAIL_POSTMARK_SERVER_TOKEN=xxx

# AWS SES
EMAIL_SES_REGION=us-east-1
EMAIL_SES_ACCESS_KEY_ID=xxx
EMAIL_SES_SECRET_ACCESS_KEY=xxx

# Default sender
EMAIL_FROM=notifications@cavendo.local
EMAIL_FROM_NAME=Cavendo
```

## Field Mapping

Remap fields in the payload:

```json
{
  "field_mapping": {
    "post_title": "deliverable.title",
    "post_content": "deliverable.content",
    "author": "deliverable.submitted_by.name"
  }
}
```

## Examples

### Notify Slack via Webhook

```json
{
  "name": "Slack notification on approval",
  "trigger_event": "deliverable.approved",
  "destination_type": "webhook",
  "destination_config": {
    "url": "https://hooks.slack.com/services/xxx/yyy/zzz",
    "payload_template": "{ \"text\": \"Approved: {{deliverable.title}} by {{deliverable.approved_by.name}}\" }"
  }
}
```

### Email Reviewers on Submission

```json
{
  "name": "Email on new submission",
  "trigger_event": "deliverable.submitted",
  "destination_type": "email",
  "destination_config": {
    "to": ["reviewer@company.com", "manager@company.com"],
    "subject_template": "New submission: {{deliverable.title}}",
    "template": "deliverable_submitted",
    "include_content_preview": true
  }
}
```

### Push to CMS on Approval

```json
{
  "name": "Publish to CMS",
  "trigger_event": "deliverable.approved",
  "trigger_conditions": {
    "tags": { "includes_any": ["blog-post"] }
  },
  "destination_type": "webhook",
  "destination_config": {
    "url": "https://cms.example.com/api/posts",
    "signing_secret": "whsec_xxx",
    "method": "POST"
  },
  "field_mapping": {
    "title": "deliverable.title",
    "content": "deliverable.content",
    "excerpt": "deliverable.summary"
  }
}
```

### Email Assignee on Task Assignment

Dynamically email the assigned agent when a task is assigned:

```json
{
  "name": "Email on Task Assignment",
  "trigger_event": "task.assigned",
  "destination_type": "email",
  "destination_config": {
    "to": ["{{assignee.email}}"],
    "subject_template": "You've been assigned: {{task.title}}",
    "include_content_preview": false
  }
}
```

### Email Assignee When Task Is Overdue

```json
{
  "name": "Overdue Task Reminder",
  "trigger_event": "task.overdue",
  "destination_type": "email",
  "destination_config": {
    "to": ["{{assignee.email}}", "admin@company.com"],
    "subject_template": "Overdue: {{task.title}} (due {{overdue_since}})"
  }
}
```

### Notify Assignee + Admin on Task Completion

```json
{
  "name": "Task Completed Notification",
  "trigger_event": "task.status_changed",
  "trigger_conditions": {
    "metadata": { "new_status": "completed" }
  },
  "destination_type": "email",
  "destination_config": {
    "to": ["{{assignee.email}}", "manager@company.com"],
    "subject_template": "Task completed: {{task.title}}"
  }
}
```
