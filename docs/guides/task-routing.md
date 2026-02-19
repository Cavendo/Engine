# Task Routing & Auto-Execution Setup

This guide walks through setting up agents, task routing, and auto-execution from scratch. If you follow these steps in order, tasks will be automatically assigned to agents and executed without manual intervention.

## Overview: How Tasks Flow

```
Task Created → Routing Rules → Agent Assigned → Dispatcher Executes → Deliverable for Review
```

1. A task is created (via UI, API, or MCP)
2. The **Task Router** checks the project's routing rules to find an agent
3. The **Task Dispatcher** picks up assigned tasks and executes them via AI providers
4. The result becomes a **deliverable** in the review queue

**Important:** If a project has no routing rules and no default agent, tasks will stay in `pending` status until manually assigned. Setting up routing is what makes the system autonomous.

## Step 1: Create Agents

Agents are the workers. Before routing can assign tasks, you need at least one agent.

### Via UI

1. Go to **Agents** → **Register Agent**
2. Fill in:
   - **Name**: e.g., `Content Writer`, `Code Reviewer`, `SEO Specialist`
   - **Type**: `autonomous` (fully automated), `semi-autonomous` (auto-execute but human reviews), or `supervised` (manual only)
   - **Capabilities**: Tags describing what this agent can do — e.g., `["writing", "blog", "seo"]`
   - **Max Concurrent Tasks**: How many tasks this agent can handle at once (default: 5)

### Via API

```bash
curl -X POST http://localhost:3001/api/agents \
  -H "Content-Type: application/json" \
  -H "Cookie: session=..." \
  -H "X-CSRF-Token: ..." \
  -d '{
    "name": "Content Writer",
    "type": "semi-autonomous",
    "description": "Writes blog posts, articles, and marketing copy",
    "capabilities": ["writing", "blog", "content", "seo"],
    "maxConcurrentTasks": 3
  }'
```

## Step 2: Configure Agent Execution

An agent needs an AI provider to actually execute tasks. Without this, tasks will be assigned but never executed.

### Via UI

1. Go to **Agents** → click **Manage** on your agent
2. Go to the **Task Execution** tab
3. Select a **Provider** (Anthropic or OpenAI)
4. Enter your **API Key**
5. Choose a **Model** (e.g., `claude-haiku-4-5-20251001` for fast/cheap, `claude-sonnet-4-5-20250929` for quality)
6. Set **Execution Mode** to `Auto`
7. Click **Test Connection** to verify the key works
8. Save

### Via API

```bash
curl -X PATCH http://localhost:3001/api/agents/1/execution \
  -H "Content-Type: application/json" \
  -H "Cookie: session=..." \
  -H "X-CSRF-Token: ..." \
  -d '{
    "provider": "anthropic",
    "providerApiKey": "sk-ant-...",
    "providerModel": "claude-haiku-4-5-20251001",
    "executionMode": "auto",
    "maxTokens": 4096,
    "temperature": 0.7
  }'
```

**Execution Modes:**

| Mode | Behavior |
|------|----------|
| `manual` | Tasks are only executed when you click "Execute Now" in the UI or call the API |
| `auto` | The Task Dispatcher automatically executes assigned tasks every 30 seconds |
| `polling` | For external agents that check for tasks themselves (not dispatcher-managed) |
| `human` | For human workers — dispatcher skips these tasks, notifications sent via delivery routes |

## Step 3: Set Up Task Routing

Routing rules tell the system which agent should handle which tasks. There are two approaches:

### Simple: Default Agent

The easiest setup — every task in a project goes to one agent.

**Via UI:**
1. Go to **Projects** → select your project → **Settings**
2. Set **Default Agent** to your agent

**Via API:**
```bash
curl -X PUT http://localhost:3001/api/projects/1 \
  -H "Content-Type: application/json" \
  -H "Cookie: session=..." \
  -H "X-CSRF-Token: ..." \
  -d '{"defaultAgentId": 1}'
```

### Advanced: Routing Rules

For projects with multiple agents, routing rules assign tasks based on tags, priority, or capabilities.

**Via API:**
```bash
curl -X PUT http://localhost:3001/api/projects/1/routing-rules \
  -H "Content-Type: application/json" \
  -H "Cookie: session=..." \
  -H "X-CSRF-Token: ..." \
  -d '{
    "rules": [
      {
        "id": "urgent-tasks",
        "name": "Urgent Tasks → Senior Agent",
        "conditions": {
          "priority": {"lte": 2}
        },
        "assign_to": 1,
        "rule_priority": 10,
        "enabled": true
      },
      {
        "id": "content-tasks",
        "name": "Content Tasks → Content Writer",
        "conditions": {
          "tags": {"includes_any": ["blog", "content", "writing"]}
        },
        "assign_to": 2,
        "fallback_to": 1,
        "rule_priority": 20,
        "enabled": true
      },
      {
        "id": "code-review",
        "name": "Code Tasks → Best Available Coder",
        "conditions": {
          "tags": {"includes_any": ["code", "review", "development"]}
        },
        "assign_to_capability": "code",
        "assign_strategy": "least_busy",
        "rule_priority": 30,
        "enabled": true
      }
    ]
  }'
```

### Routing Rule Reference

Each rule has:

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier for the rule |
| `name` | Yes | Human-readable name |
| `conditions` | No | Match criteria (see below). Empty = matches all tasks |
| `assign_to` | No* | Direct agent ID to assign to |
| `assign_to_capability` | No* | Find agent by capability string |
| `assign_strategy` | No | `least_busy`, `round_robin`, `first_available`, `random` |
| `fallback_to` | No | Fallback agent ID if primary is unavailable |
| `rule_priority` | No | Lower number = evaluated first (default: 999) |
| `enabled` | No | Set `false` to disable without deleting |

*One of `assign_to` or `assign_to_capability` is required.

### Condition Types

```json
{
  "conditions": {
    "tags": {
      "includes_any": ["blog", "content"],
      "includes_all": ["urgent", "client"]
    },
    "priority": {
      "lte": 2,
      "gte": 1
    }
  }
}
```

- `tags.includes_any` — Task has at least one of these tags
- `tags.includes_all` — Task has all of these tags
- `priority.lte` — Priority is less than or equal to (1=critical, 4=low)
- `priority.gte` — Priority is greater than or equal to

### Routing Evaluation Order

1. **Preferred agent** — If the task has `preferred_agent_id` set, use that agent (if available and capable)
2. **Routing rules** — Evaluate rules in `rule_priority` order (lowest first), first match wins
3. **Default agent** — If no rules match, fall back to the project's `default_agent_id`
4. **Unassigned** — If none of the above apply, the task stays `pending` with no agent

### Test Routing (Dry Run)

Preview which agent a task would be routed to without creating it:

```bash
curl -X POST http://localhost:3001/api/projects/1/routing-rules/test \
  -H "Content-Type: application/json" \
  -H "Cookie: session=..." \
  -H "X-CSRF-Token: ..." \
  -d '{
    "tags": ["blog", "seo"],
    "priority": 2
  }'
```

Response:
```json
{
  "matched": true,
  "agentId": 2,
  "ruleId": "content-tasks",
  "ruleName": "Content Tasks → Content Writer",
  "decision": "Assigned via rule \"Content Tasks → Content Writer\" to agent 2"
}
```

## Step 4: Create Tasks

Now when you create a task in a project with routing configured, it will be automatically assigned.

```bash
curl -X POST http://localhost:3001/api/tasks \
  -H "Content-Type: application/json" \
  -H "Cookie: session=..." \
  -H "X-CSRF-Token: ..." \
  -d '{
    "title": "Write a blog post about AI workflows",
    "description": "Create a 1000-word blog post...",
    "projectId": 1,
    "tags": ["blog", "content"],
    "priority": 3
  }'
```

The task will be:
1. Created with status `pending`
2. Routed to an agent → status changes to `assigned`
3. Picked up by the dispatcher → status changes to `in_progress`
4. Executed → deliverable created, status changes to `review`

## What Happens Without Routing

If a project has **no routing rules** and **no default agent**:

- Tasks stay in `pending` status indefinitely
- The dispatcher ignores unassigned tasks
- You'll see this in the server logs: `Task #X not routed — no rules or default agent for project Y`
- You must manually assign tasks via the UI or API

**Quick fix:** Set a default agent on the project. Every task will go to that agent.

## Dispatcher Error Recovery

When task execution fails, the dispatcher uses category-based cooldowns before retrying:

| Error Category | Cooldown | Example |
|---|---|---|
| `config_error` | 5 minutes | Bad encryption key, missing ENCRYPTION_KEY env var |
| `auth_error` | 5 minutes | Invalid or expired API key |
| `timeout` | 10 minutes | Provider took too long to respond |
| `overloaded` | 10 minutes | Provider returned 503/529 |
| `rate_limited` | 60 minutes | Provider quota hit |
| `quota_exceeded` | 6 hours | Billing/plan issue with provider |
| `bad_request` | 6 hours | Malformed prompt or unsupported model |
| `unknown` | 6 hours | Unexpected errors |

**Immediate recovery:** When you update an agent's API key or provider, all stuck tasks for that agent have their error cache cleared automatically. The dispatcher picks them up on the next cycle (within 30 seconds).

**Manual retry:** Use `POST /api/tasks/:id/retry` to clear a task's error and re-queue it immediately.

## Human Agents

Not all "agents" need to be AI. When you create a **user** in Cavendo, a linked human agent is automatically created. The routing system treats them the same as AI agents — tasks get assigned, notifications fire — but the dispatcher won't try to auto-execute their tasks.

### Adding a Team Member

The simplest way is via the **Users** page in the UI. Creating a user automatically creates a linked agent with `execution_mode: 'human'`.

Via API:

```bash
curl -X POST http://localhost:3001/api/users \
  -H "Content-Type: application/json" \
  -H "Cookie: session=..." \
  -H "X-CSRF-Token: ..." \
  -d '{
    "email": "john@example.com",
    "password": "securepassword",
    "name": "John (Designer)",
    "role": "reviewer"
  }'
```

The response includes `linked_agent_id` — use this ID when setting up routing rules. No separate agent creation or execution mode setup is needed.

**Status cascade**: Deactivating or deleting a user automatically disables/deletes their linked agent.

### Notifying Human Agents

Use delivery routes to notify humans when tasks are assigned. The `task.assigned` trigger fires for every assignment — human or AI.

**Example: Email John when he gets a task**

```bash
curl -X POST http://localhost:3001/api/projects/1/routes \
  -H "Content-Type: application/json" \
  -H "Cookie: session=..." \
  -H "X-CSRF-Token: ..." \
  -d '{
    "name": "Notify John on assignment",
    "trigger_event": "task.assigned",
    "trigger_conditions": {},
    "destination_type": "email",
    "destination_config": {
      "to": "john@example.com",
      "subject": "New task assigned: {{task.title}}",
      "body": "You have been assigned task #{{task.id}}: {{task.title}}\n\nPriority: {{task.priority}}\n\nView it at: https://your-instance.com/tasks/{{task.id}}"
    }
  }'
```

**Example: Slack notification for all assignments**

```bash
curl -X POST http://localhost:3001/api/projects/1/routes \
  -H "Content-Type: application/json" \
  -H "Cookie: session=..." \
  -H "X-CSRF-Token: ..." \
  -d '{
    "name": "Slack assignment notifications",
    "trigger_event": "task.assigned",
    "destination_type": "webhook",
    "destination_config": {
      "url": "https://hooks.slack.com/services/T.../B.../xxx",
      "headers": {"Content-Type": "application/json"},
      "payload_template": "{\"text\": \"📋 *{{task.title}}* assigned to {{agent.name}}\\nPriority: {{task.priority}}\"}"
    }
  }'
```

The `task.assigned` event payload includes the agent info (`agent.name`, `agent.executionMode`) so your templates can differentiate between human and AI assignments.

### Human + AI Mixed Teams

Routing rules don't care whether an agent is human or AI. You can mix both in the same project:

```json
{
  "rules": [
    {
      "id": "design-tasks",
      "name": "Design → John (human)",
      "conditions": {"tags": {"includes_any": ["design", "ux", "figma"]}},
      "assign_to": 3,
      "rule_priority": 10
    },
    {
      "id": "code-tasks",
      "name": "Code → AI Code Reviewer",
      "conditions": {"tags": {"includes_any": ["code", "review"]}},
      "assign_to": 1,
      "rule_priority": 20
    }
  ]
}
```

John gets notified via email/Slack. The AI agent auto-executes. Both participate in the same review workflow.

### Human Agents with MCP

If a human agent is linked to a user (`owner_user_id`), that user can use MCP tools (Claude Desktop, Cursor, etc.) with their personal `cav_uk_` key. They can say "show me my tasks" and the MCP server returns tasks assigned to their linked agent.

They can also ask their AI assistant to help with the task — the human is still the assigned agent, but they're using AI as a tool. The deliverable gets submitted under the human's agent identity.

## Recommended Setups

### Solo Agent (Simplest)

One agent handles everything:

1. Create one agent with `execution_mode: auto`
2. Set it as the default agent on your project
3. All tasks route to it automatically

### Multi-Agent by Specialty

Different agents for different work:

1. Create agents with specific capabilities: `Content Writer ["writing", "blog"]`, `Code Reviewer ["code", "review"]`
2. Add routing rules that match task tags to agent capabilities
3. Set a default agent as the catch-all fallback

### Multi-Agent with Load Balancing

Distribute work across agents with the same capability:

1. Create multiple agents with overlapping capabilities (e.g., three agents all with `["writing"]`)
2. Use `assign_to_capability` with `assign_strategy: "least_busy"`
3. Tasks spread across available agents based on current load

## Troubleshooting

### Tasks stuck in `pending`

- **No agent assigned?** Check that the project has routing rules or a default agent
- **Agent at capacity?** Check `active_task_count` vs `max_concurrent_tasks` on the agent
- **No matching rule?** Use the routing test endpoint to debug: `POST /api/projects/:id/routing-rules/test`

### Tasks stuck in `assigned`

- **No provider configured?** The agent needs a provider and API key set up (Step 2)
- **Execution mode not `auto`?** The dispatcher only picks up tasks for agents with `execution_mode: 'auto'`
- **Execution error?** Check the task's context field for `lastExecutionError` — use `POST /api/tasks/:id/retry` to clear it

### Tasks executed but deliverable is empty

- **Check model/tokens**: The model may need more `max_tokens` for complex tasks
- **Check system prompt**: A bad system prompt can confuse the model
- **Check task description**: More detailed descriptions produce better output
