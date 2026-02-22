# Architecture Overview

Cavendo Engine is designed around a simple but powerful workflow: **agents receive tasks, do work, submit deliverables, and get human feedback**.

## Core Workflow

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Human      │     │   Cavendo    │     │    Agent     │
│   Reviewer   │────▶│   Engine     │◀────│  (AI/Bot)    │
└──────────────┘     └──────────────┘     └──────────────┘
       │                    │                    │
       │  1. Create Task    │                    │
       │───────────────────▶│                    │
       │                    │  2. Assign Task    │
       │                    │───────────────────▶│
       │                    │                    │
       │                    │  3. Get Context    │
       │                    │◀───────────────────│
       │                    │                    │
       │                    │  4. Submit Work    │
       │                    │◀───────────────────│
       │                    │                    │
       │  5. Review Work    │                    │
       │◀───────────────────│                    │
       │                    │                    │
       │  6. Approve/Revise │                    │
       │───────────────────▶│                    │
       │                    │  7. Webhook Event  │
       │                    │───────────────────▶│
```

## Key Concepts

### Agents

Agents are AI systems or bots that perform work. Each agent has:

- **Type**: Supervision level (autonomous, semi-autonomous, supervised)
- **Capabilities**: What the agent can do (research, writing, coding)
- **Specializations**: Rich metadata (business lines, content types, etc.)
- **Capacity**: Max concurrent tasks and active task count tracking
- **Status**: active, paused, or disabled
- **API Keys**: Authentication credentials with scoped permissions
- **Webhooks**: Endpoints for real-time event notifications

### Tasks

Tasks represent units of work assigned to agents. Each task has:

- **Title & Description**: What needs to be done
- **Priority**: Critical (1) to Low (4)
- **Tags**: Labels for routing rule matching
- **Status**: pending → assigned → in_progress → review → completed
- **Project**: Optional project association
- **Context**: Additional structured data for the agent
- **Routing Decision**: How the task was assigned (rule ID, decision log)

### Deliverables

Deliverables are the work products submitted by agents. Each deliverable has:

- **Content**: The actual work (markdown, code, JSON, etc.)
- **Summary**: Text description shown in the Overview tab
- **Files**: Array of file attachments (stored on disk)
- **Actions**: Follow-up items with estimated time
- **Status**: pending → approved | revision_requested → revised | rejected
- **Version**: Revision tracking with `parent_id` linking versions
- **Feedback**: Human reviewer comments
- **Token Usage**: Input/output token counts for AI-generated content

### Projects

Projects group related tasks and knowledge. Projects provide:

- **Organization**: Logical grouping of related work
- **Knowledge Base**: Project-specific documentation and context
- **Progress Tracking**: Task status aggregation
- **Routing Rules**: Automatic task assignment configuration
- **Default Agent**: Fallback agent when no rules match

### Knowledge Base

The knowledge base stores project context that agents can access:

- **Documents**: Markdown, HTML, JSON, or plain text
- **Categories**: Logical groupings (guidelines, reference, etc.)
- **Tags**: Searchable metadata
- **Search**: Full-text search across all knowledge

## Data Flow

### Agent Authentication

```
Agent Request
      │
      ▼
┌─────────────────┐
│ X-Agent-Key     │
│ Header Check    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Hash API Key    │
│ Compare to DB   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Check Scopes    │
│ Verify Active   │
└────────┬────────┘
         │
         ▼
    Request OK
```

### Task Assignment Flow

```
┌──────────┐  create   ┌──────────┐
│ Task     │─────────▶│ pending  │
│ Created  │          └────┬─────┘
└──────────┘               │
                           │ assign agent
                           ▼
                    ┌──────────┐
                    │ assigned │
                    └────┬─────┘
                         │
                         │ agent starts
                         ▼
                    ┌──────────────┐
                    │ in_progress  │
                    └────┬─────────┘
                         │
                         │ submit deliverable
                         ▼
                    ┌──────────┐
                    │ review   │
                    └────┬─────┘
                         │
              ┌──────────┼──────────┐
              │          │          │
         approved    revision   rejected
              │          │          │
              ▼          │          ▼
        ┌──────────┐     │    ┌──────────┐
        │completed │     │    │assigned  │
        └──────────┘     │    └──────────┘
                         │
                         ▼
                  task → assigned
                  deliverable → revised
                  (dispatcher re-executes
                   or agent submits revision)
```

### Task Routing Flow

When a task is created without an explicit agent assignment:

```
Task Created (no agent)
      │
      ▼
┌─────────────────┐
│ Load Project    │
│ Routing Rules   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Match Conditions│◀─── tags, priority, metadata
│ (priority order)│
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
 matched   no match
    │         │
    ▼         ▼
┌─────────┐ ┌─────────────┐
│ Check   │ │ Try Default │
│ Agent   │ │ Agent       │
│ Capacity│ └──────┬──────┘
└────┬────┘        │
     │        ┌────┴────┐
     ▼        │         │
┌─────────┐ found    not found
│ Assign  │   │         │
│ Agent   │   ▼         ▼
└────┬────┘ assign   pending
     │
     ▼
┌─────────────────┐
│ Increment       │
│ active_task_cnt │
└─────────────────┘
```

Capability-based routing selects agents using strategies:
- **least_busy**: Agent with lowest active_task_count
- **round_robin**: Fair distribution (uses least_busy as proxy)
- **first_available**: First agent with capacity (by ID)
- **random**: Random available agent

### Task Dispatcher (Auto-Execution)

The dispatcher is a background service that automatically executes tasks for agents with `execution_mode = 'auto'`:

```
┌─────────────────────────────────┐
│ Dispatcher Poll Cycle (30s)     │
└────────────┬────────────────────┘
             │
             ▼
┌─────────────────────────────────┐
│ Find eligible tasks:            │
│ - status: pending/assigned      │
│ - agent: auto mode, active      │
│ - agent: has provider key       │
│ - agent: has capacity           │
│ - no recent non-retryable error │
└────────────┬────────────────────┘
             │
             ▼
┌─────────────────────────────────┐
│ For each task:                  │
│ 1. Increment active_task_count  │
│ 2. Gather context (knowledge,   │
│    previous deliverables,       │
│    feedback, related tasks)     │
│ 3. Call AI provider API         │
│ 4. Create deliverable           │
│    (with parent_id if revision) │
│ 5. Set task → review            │
│ 6. Decrement active_task_count  │
│ 7. Log to activity tables       │
└────────────┬────────────────────┘
             │
        ┌────┴────┐
        │         │
    success     failure
        │         │
        ▼         ▼
  deliverable   flag task with
  created       error details
  (pending)     (retryable? wait 5m)
```

### Webhook Delivery

```
Event Triggered
      │
      ▼
┌─────────────────┐
│ Find Webhooks   │
│ for Agent       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Create Delivery │
│ Record          │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ HMAC Sign       │
│ Payload         │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     success     ┌──────────┐
│ POST to URL     │────────────────▶│delivered │
└────────┬────────┘                 └──────────┘
         │
         │ failure
         ▼
┌─────────────────┐
│ Retry with      │     max retries
│ Exponential     │────────────────▶ failed
│ Backoff         │
└─────────────────┘
```

### Delivery Routes

Routes automate content delivery when events occur (e.g., deliverable approved):

```
Event Triggered
      │
      ▼
┌─────────────────┐
│ Match Routes    │
│ for Project     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Check Trigger   │
│ Conditions      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Build Payload   │
│ Apply Mapping   │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
 webhook    email
    │         │
    ▼         ▼
┌───────┐  ┌───────┐
│ POST  │  │ SMTP  │
│ URL   │  │ Send  │
└───────┘  └───────┘
```

## Database Schema

```sql
-- Core entities
agents          -- AI agents (execution config, capacity, specializations)
agent_keys      -- API keys for agent authentication
tasks           -- Work items (tags, routing, required_capabilities)
deliverables    -- Submitted work (files, actions, version chain via parent_id)
projects        -- Organizational containers (routing rules, default agent)
sprints         -- Sprint/milestone management
knowledge       -- Project documentation
comments        -- Threaded discussions on tasks/deliverables

-- Execution & tracking
task_progress     -- Progress updates during task execution
agent_activity    -- Agent-scoped audit trail
activity_log      -- Universal entity activity log (tasks + deliverables)

-- Event system
webhooks          -- Webhook configurations (agent-level)
webhook_deliveries -- Delivery log with retry tracking
routes            -- Delivery routes (project-level)
delivery_logs     -- Route delivery history

-- User management
users           -- Admin UI users
user_keys       -- Personal API keys for MCP access
sessions        -- User session tracking
```

## Security Model

### Authentication Layers

1. **User Authentication**: Session-based for Admin UI
2. **Agent Authentication**: API key with scoped permissions
3. **Webhook Verification**: HMAC signatures for integrity

### Scopes

API keys can have restricted scopes:

- `read` - Read tasks and context
- `write` - Submit deliverables and update status
- `webhook:create` - Create webhooks (self-service)
- `*` - Full access

### Agent Types

- **Supervised**: All deliverables require human approval
- **Semi-autonomous**: Some actions allowed without approval
- **Autonomous**: Full autonomy (use with caution)

## Server Startup Architecture

The server uses an app factory pattern for composability:

```
server/env.js          ← Env bootstrap (.env loading/generation, runs at import)
server/app.js          ← createApp(options?) factory, returns { app, start, stop }
server/index.js        ← Thin bootstrap: imports createApp, calls start(), signal handlers
```

`createApp()` assembles middleware and routes, then returns lifecycle methods:

- **`start({ port, host })`** — Initializes the database, runs migrations, crypto health check, binds the HTTP server, and starts background workers (task dispatcher, retry sweep, session cleanup). Idempotent — calling twice returns the same server.
- **`stop()`** — Gracefully shuts down the HTTP server, stops background workers, clears timers, and closes the database connection. Idempotent and safe to call without prior `start()`.

Four async lifecycle hooks allow external code to extend the startup sequence:

| Hook | When it runs | Use case |
|------|-------------|----------|
| `beforeRoutes(app)` | Before engine routes are mounted | Custom middleware |
| `afterRoutes(app)` | After engine routes, before SPA fallback/error handlers | Additional API routes |
| `beforeStart(app)` | After DB init, before HTTP listen | Extra data seeding |
| `onStarted({ app, server })` | After server is listening | Post-startup tasks (fatal on throw) |

This enables downstream projects (e.g., Cavendo Cloud) to import Engine as a subtree and layer additional routes via `afterRoutes` without forking the codebase.

**Known limitation:** `stop()` closes the SQLite connection (`better-sqlite3` singleton), which is terminal. Restart requires a new process.

## Extension Points

### Custom Integrations

1. **MCP Server**: Model Context Protocol for Claude Desktop
2. **Python SDK**: Client library for agent frameworks
3. **Webhooks**: Push events to any HTTP endpoint (agent-level)
4. **Delivery Routes**: Auto-route approved content to external systems (project-level)
5. **REST API**: Full programmatic access

### Email Providers

Routes support multiple email providers:

- SMTP (default)
- SendGrid
- Mailjet
- Postmark
- AWS SES

### Storage Adapters (Future)

- Local filesystem (default)
- AWS S3
- DigitalOcean Spaces
- MinIO
- Cloudflare R2

### Database Adapters (Future)

- SQLite (default, OSS)
- MySQL (Cloud)
- PostgreSQL (Cloud)
