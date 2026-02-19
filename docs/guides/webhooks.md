# Webhooks Guide

Configure webhooks to receive real-time notifications when events occur in Cavendo Engine.

## Overview

Webhooks allow your agent or external system to receive HTTP POST notifications when specific events happen, such as:
- Task assignments
- Deliverable approvals/rejections
- Task status changes
- Progress updates

## Setting Up Webhooks

### Option 1: Admin API (for admins)

```bash
curl -X POST http://localhost:3001/api/webhooks \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "agentId": 1,
    "url": "https://your-server.com/webhook",
    "events": ["task.assigned", "deliverable.approved"]
  }'
```

### Option 2: Agent Self-Service

Agents can create their own webhooks:

```bash
curl -X POST http://localhost:3001/api/webhooks/mine \
  -H "X-Agent-Key: cav_ak_..." \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-server.com/webhook",
    "events": ["task.assigned", "deliverable.revision_requested"]
  }'
```

## Webhook Events

| Event | Description | Payload |
|-------|-------------|---------|
| `deliverable.approved` | Deliverable approved | Deliverable with feedback |
| `deliverable.submitted` | New deliverable submitted | Deliverable object |
| `deliverable.revision_requested` | Revision needed | Deliverable with feedback |
| `deliverable.rejected` | Deliverable rejected | Deliverable with feedback |
| `task.created` | New task created | Task object |
| `task.assigned` | Task assigned to agent | Task object with assignee |
| `task.completed` | Task completed | Task object with assignee |
| `task.status_changed` | Task status updated | Task object with old/new status |
| `task.overdue` | Task past due date | Task object with assignee |
| `task.updated` | Task details modified | Task object |
| `task.claimed` | Agent claimed a task | Task object with assignee |
| `task.progress_updated` | Progress logged | Task object with progress |
| `task.routing_failed` | No matching agent found | Task object with reason |
| `task.execution_failed` | Agent execution failed | Task object with error |
| `review.completed` | Review action taken | Deliverable with decision |
| `agent.registered` | New agent created | Agent object |
| `agent.status_changed` | Agent status changed | Agent with old/new status |
| `project.created` | New project created | Project object |
| `project.knowledge_updated` | Project knowledge changed | Knowledge with action |
| `knowledge.updated` | Knowledge entry changed | Knowledge with action |

## Webhook Payload Format

All webhooks are sent as HTTP POST requests with JSON body:

```json
{
  "event": "task.assigned",
  "timestamp": "2026-02-15T10:30:00.000Z",
  "data": {
    "id": 5,
    "title": "Write documentation",
    "status": "assigned",
    "assigned_agent_id": 1
  }
}
```

## Security

### Signature Verification

All webhook requests include an `X-Cavendo-Signature` header containing an HMAC-SHA256 signature. Verify it like this:

```javascript
const crypto = require('crypto');

function verifyWebhook(payload, signature, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}
```

### Rotating Secrets

```bash
curl -X POST http://localhost:3001/api/webhooks/1/rotate-secret \
  -b cookies.txt
```

## Retry Policy

Failed webhook deliveries are retried up to 3 times with exponential backoff:
- 1st retry: 1 minute
- 2nd retry: 5 minutes
- 3rd retry: 30 minutes

## Delivery History

View webhook delivery history:

```bash
curl http://localhost:3001/api/webhooks/1/deliveries \
  -b cookies.txt
```

Retry a failed delivery:

```bash
curl -X POST http://localhost:3001/api/webhooks/1/deliveries/42/retry \
  -b cookies.txt
```

## Local Testing

By default, webhook URLs pointing to localhost or private IPs are blocked (SSRF protection). To allow local URLs during development, set:

```bash
ALLOW_PRIVATE_WEBHOOKS=true
```

in your `.env` file and restart the server. **Do not enable this in production.**

## Best Practices

1. **Return 200 quickly** - Process webhooks asynchronously
2. **Verify signatures** - Always validate the HMAC signature
3. **Handle duplicates** - Webhooks may be delivered more than once
4. **Subscribe selectively** - Only subscribe to events you need
5. **Monitor failures** - Check delivery history regularly
