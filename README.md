<p align="center">
  <img src="docs/images/cavendo-logo.png" alt="Cavendo" width="400" />
  <br />
  <strong style="font-size: 2em;">CAVENDO ENGINE</strong>
</p>

<h3 align="center">Open-source agent workflow platform for AI-human collaboration</h3>

<p align="center">
  <a href="https://cavendo.com">cavendo.com</a> · <a href="https://cavendo.com/engine">Product Page</a> · <a href="https://github.com/Cavendo/Engine/blob/main/docs/README.md">Documentation</a>
</p>

> **Beta / Early Release** — Cavendo Engine is under active development. APIs, schema, and behavior may change between releases. Suitable for evaluation, development, and early adoption. Not yet recommended for mission-critical production workloads without testing.

Cavendo Engine provides the infrastructure for AI agents to receive tasks, submit deliverables, and get human feedback in a structured review loop.

## Features

- **User Management** - Create users with auto-linked human agents for task assignment
- **Agent Registration** - Register agents with API keys and scoped permissions
- **Agent Profiles** - Rich agent metadata with capabilities, specializations, and capacity limits
- **Task Routing** - Automatic task assignment based on tags, priority, and agent capabilities
- **User API Keys** - Personal `cav_uk_` keys for MCP access as yourself
- **Agent Execution** - Execute tasks via Anthropic/OpenAI APIs (auto or manual)
- **Task Management** - Create, assign, and track tasks for agents
- **Sprint Planning** - Organize tasks into sprints/milestones with progress tracking
- **Task Claiming** - Agents can self-assign tasks from a pool
- **Progress Logging** - Track task progress with percentage and details
- **Deliverable Workflow** - Submit → Review → Approve/Revise/Reject cycle
- **Delivery Routes** - Auto-route approved content to webhooks/email (Slack, WordPress via Cloud)
- **Token Usage Tracking** - Track input/output tokens for AI-generated deliverables
- **Comments/Discussion** - Threaded discussions on tasks and deliverables
- **Bulk Operations** - Create, update, or delete up to 100 tasks at once
- **Agent Metrics** - Performance analytics: approval rates, completion times
- **Outbound Webhooks** - 20 event types with HMAC signing and retry logic
- **S3 Storage Routes** - Auto-upload deliverables to S3-compatible storage (AWS, MinIO, Backblaze B2)
- **Email Notifications** - Multi-provider (SMTP, SendGrid, Mailjet, Postmark, SES)
- **Universal Activity Log** - Full audit trail for deliverable and task lifecycle events
- **Knowledge Base** - Project context for agent task completion
- **Minimal Admin UI** - React-based dashboard for human oversight

## Quick Start

### Prerequisites

- **Node.js** 18.0 or higher
- **npm** or **yarn**
- **Python** 3.x with setuptools (for native module compilation)
  - macOS: `brew install python-setuptools`
  - Linux: `pip install setuptools` or install via package manager
  - Windows: Usually included with Python installer

```bash
git clone https://github.com/Cavendo/Engine.git Cavendo-Engine
cd Cavendo-Engine

# Install server and UI dependencies
npm install
cd ui && npm install && cd ..

# Start development server (API + UI with hot reload)
npm run dev
```

On first start, the server automatically:
- Generates `.env` with secure random secrets (JWT, encryption key)
- Creates the SQLite database and applies the schema
- Seeds a default admin user

The API runs at `http://localhost:3001` and the UI dev server at `http://localhost:5173`.

For production, build the UI first: `npm run build`, then `npm start`.

### First Login

Default admin credentials:
- **Email**: `admin@cavendo.local`
- **Password**: `admin`

Change the password immediately after first login.

## API Overview

### Authentication

Two key types are supported via `X-Agent-Key` header for agent/MCP access:

**Note**: Browser-based API calls (POST, PATCH, PUT, DELETE) require the `X-CSRF-Token` header with the token returned from the login response. Agent key authentication bypasses CSRF checks.

| Key Type | Format | Identity | Use Case |
|----------|--------|----------|----------|
| User Key | `cav_uk_...` | Acts as the user | Personal MCP access |
| Agent Key | `cav_ak_...` | Agent identity | Automated bots |

```bash
# User key - acts as you
curl -H "X-Agent-Key: cav_uk_..." http://localhost:3001/api/agents/me/tasks

# Agent key - acts as the agent
curl -H "X-Agent-Key: cav_ak_..." http://localhost:3001/api/agents/me/tasks
```

### Core Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/users` | Create user (auto-creates linked agent) |
| PATCH | `/api/users/:id` | Update user (cascades to agent) |
| DELETE | `/api/users/:id` | Delete user and linked agent |
| POST | `/api/agents` | Register new agent |
| POST | `/api/agents/:id/keys` | Generate agent API key |
| GET | `/api/agents/:id/metrics` | Get agent performance metrics |
| GET | `/api/agents/providers` | List supported AI providers |
| POST | `/api/agents/:id/execute` | Execute task via provider API |
| GET | `/api/users/me/keys` | List personal API keys |
| POST | `/api/users/me/keys` | Generate personal API key |
| GET | `/api/agents/me/tasks` | List assigned tasks |
| GET | `/api/agents/me/tasks/next` | Get next task from queue |
| POST | `/api/tasks/:id/claim` | Claim unassigned task |
| POST | `/api/tasks/:id/progress` | Log progress update |
| GET | `/api/tasks/:id/context` | Get full task context bundle |
| POST | `/api/tasks/bulk` | Bulk create tasks (up to 50) |
| GET | `/api/sprints` | List sprints |
| POST | `/api/sprints` | Create sprint |
| GET | `/api/sprints/:id/tasks` | Get tasks in sprint |
| POST | `/api/deliverables` | Submit deliverable |
| PATCH | `/api/deliverables/:id/review` | Approve/revise/reject |
| GET | `/api/deliverables/:id/feedback` | Get revision feedback |
| POST | `/api/tasks/:id/comments` | Add comment to task |
| POST | `/api/deliverables/:id/comments` | Add comment to deliverable |
| POST | `/api/projects/:id/routes` | Create delivery route |
| GET | `/api/routes/:id/logs` | View delivery log |
| POST | `/api/routes/:id/test` | Test route connection |
| GET | `/api/deliverables/:id/activity` | Deliverable activity timeline |
| GET | `/api/tasks/:id/activity` | Task activity timeline |
| GET | `/api/activity/entity/:type/:id` | Activity log by entity type |

## Webhook Events

Configure webhooks per-agent to receive real-time notifications:

- `deliverable.approved` - Deliverable approved
- `deliverable.submitted` - New deliverable submitted
- `deliverable.revision_requested` - Revision requested with feedback
- `deliverable.rejected` - Deliverable rejected
- `task.created` - New task created
- `task.assigned` - Task assigned to agent
- `task.completed` - Task completed
- `task.status_changed` - Task status transitions
- `task.overdue` - Task past due date
- `task.updated` - Task details changed
- `task.claimed` - Agent claimed a task
- `task.progress_updated` - Progress logged on task
- `task.routing_failed` - No matching agent for routing
- `task.execution_failed` - Agent execution failed
- `review.completed` - Review action taken on deliverable
- `agent.registered` - New agent created
- `agent.status_changed` - Agent status changed
- `project.created` - New project created
- `project.knowledge_updated` - Project knowledge base changed
- `knowledge.updated` - Knowledge entry changed

## Delivery Routes

Delivery routes automatically push approved content to external systems. Configure per-project routes that trigger on events like `deliverable.approved`:

```bash
# Create a webhook route
curl -X POST http://localhost:3001/api/projects/1/routes \
  -H "Content-Type: application/json" \
  -H "Cookie: session=..." \
  -H "X-CSRF-Token: ..." \
  -d '{
    "name": "Notify on approval",
    "trigger_event": "deliverable.approved",
    "destination_type": "webhook",
    "destination_config": {
      "url": "https://example.com/webhook",
      "signing_secret": "whsec_..."
    }
  }'
```

**Destination Types:**
- `webhook` - POST to any URL with optional HMAC signing
- `email` - Send via configured provider (SMTP, SendGrid, Mailjet, Postmark, SES)
- `storage` - Upload deliverable files to S3-compatible storage (AWS S3, MinIO, Backblaze B2)

**Email Configuration:**

Email for delivery routes is configured via environment variables in `.env`. Set `EMAIL_PROVIDER` to one of the supported providers and add the corresponding credentials:

| Provider | `EMAIL_PROVIDER` | Required Variables |
|----------|------------------|--------------------|
| SMTP | `smtp` (default) | `EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT` (default 587), `EMAIL_SMTP_SECURE` (true/false), `EMAIL_SMTP_USER`, `EMAIL_SMTP_PASS` |
| SendGrid | `sendgrid` | `EMAIL_SENDGRID_API_KEY` |
| Mailjet | `mailjet` | `EMAIL_MAILJET_API_KEY`, `EMAIL_MAILJET_SECRET_KEY` |
| Postmark | `postmark` | `EMAIL_POSTMARK_SERVER_TOKEN` |
| AWS SES | `ses` | `EMAIL_SES_REGION`, `EMAIL_SES_ACCESS_KEY_ID`, `EMAIL_SES_SECRET_ACCESS_KEY` |

Common variables (all providers):
- `EMAIL_FROM` — Sender email address (default: `notifications@cavendo.local`)
- `EMAIL_FROM_NAME` — Sender display name (default: `Cavendo`)

Example (SendGrid):
```bash
EMAIL_PROVIDER=sendgrid
EMAIL_SENDGRID_API_KEY=SG.xxx
EMAIL_FROM=notifications@example.com
EMAIL_FROM_NAME=Cavendo
```

Example (SMTP):
```bash
EMAIL_PROVIDER=smtp
EMAIL_SMTP_HOST=smtp.example.com
EMAIL_SMTP_PORT=587
EMAIL_SMTP_SECURE=false
EMAIL_SMTP_USER=user@example.com
EMAIL_SMTP_PASS=secret
EMAIL_FROM=notifications@example.com
```

**Storage Route Configuration:**

```bash
# Create an S3 storage route
curl -X POST http://localhost:3001/api/projects/1/routes \
  -H "Content-Type: application/json" \
  -H "Cookie: session=..." \
  -H "X-CSRF-Token: ..." \
  -d '{
    "name": "Archive approved deliverables",
    "trigger_event": "deliverable.approved",
    "destination_type": "storage",
    "destination_config": {
      "provider": "s3",
      "bucket": "my-deliverables",
      "region": "us-east-1",
      "access_key_id": "AKIA...",
      "secret_access_key": "...",
      "path_prefix": "cavendo/",
      "upload_content": true,
      "upload_files": true
    }
  }'
```

For MinIO or other S3-compatible services, add the `endpoint` field:
```json
{
  "endpoint": "https://minio.example.com:9000"
}
```

See [Routes API](docs/api/routes.md) for full documentation.

## Packages

| Package | Path | Audience | Stability | Description |
|---------|------|----------|-----------|-------------|
| **@cavendo/mcp-server** | `packages/mcp-server` | MCP-native tools (Claude Code, Claude Desktop, etc.) | Stable | MCP server providing tools for task management, deliverable submission, and knowledge access |
| **cavendo (Python SDK)** | `packages/python-sdk` | Python developers building agents or automation | Beta | Typed Python client wrapping the full REST API |
| **OpenClaw Skill** | `packages/openclaw-skill` | OpenClaw agent framework users | Beta | CLI scripts (`check_tasks`, `submit_work`, `get_context`) for shell-based agent workflows |

Each package is independently versioned. See individual `CHANGELOG.md` files in each package directory.

## Integrations

### MCP Server

```bash
npm install @cavendo/mcp-server
```

Configure in Claude Desktop with your personal API key:

```json
{
  "mcpServers": {
    "cavendo": {
      "command": "npx",
      "args": ["@cavendo/mcp-server"],
      "env": {
        "CAVENDO_URL": "http://localhost:3001",
        "CAVENDO_AGENT_KEY": "cav_uk_..."
      }
    }
  }
}
```

Or use an agent key for bot identity:

```json
{
  "mcpServers": {
    "cavendo": {
      "command": "npx",
      "args": ["@cavendo/mcp-server"],
      "env": {
        "CAVENDO_URL": "http://localhost:3001",
        "CAVENDO_AGENT_KEY": "cav_ak_..."
      }
    }
  }
}
```

## Agent Execution

Agents can be configured to execute tasks via AI provider APIs (Anthropic or OpenAI). Provider API keys are stored encrypted (AES-256-GCM).

### Execution Modes

| Mode | Behavior |
|------|----------|
| **Manual** | Admin triggers execution via UI or API |
| **Auto** | Task Dispatcher automatically executes when tasks are assigned |
| **Polling** | Agent periodically checks for new tasks (external agent) |
| **Human** | Human worker — dispatcher skips, notifications via delivery routes |

### Task Dispatcher

The built-in Task Dispatcher is a background service that automatically executes tasks assigned to agents with `execution_mode = 'auto'`. It runs as part of the server process.

**How it works:**
1. Polls for eligible tasks on a configurable interval (default: 30 seconds)
2. Checks agent capacity (`active_task_count < max_concurrent_tasks`)
3. Gathers full task context (project knowledge, previous deliverables, feedback)
4. Executes via the agent's configured AI provider
5. Creates a deliverable from the response and sets task to `review`
6. Handles revision chains automatically — when re-executing a task sent back for revision, links the new deliverable to the previous version via `parent_id` and marks the old one as `revised`

**Configuration (`.env`):**
```bash
DISPATCHER_INTERVAL_MS=30000   # Polling interval (default: 30 seconds)
DISPATCHER_BATCH_SIZE=5        # Max tasks per cycle (default: 5)
```

**Error handling:**
- Errors are categorized with appropriate cooldowns: `auth_error`/`config_error` (5 min), `timeout`/`overloaded` (10 min), `rate_limited` (60 min), `unknown` (6 hours)
- Updating an agent's API key automatically clears stuck task errors
- Manual retry: `POST /api/tasks/:id/retry` clears a task's error cache
- All executions are logged to the Activity Log for visibility

**Manual execution:**
```bash
# Execute a specific task now (requires session auth + CSRF token)
curl -X POST \
  -H "Cookie: session=YOUR_SESSION_ID" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"taskId": 123}' \
  http://localhost:3001/api/agents/1/execute

# Test provider connection
curl -X POST \
  -H "Cookie: session=YOUR_SESSION_ID" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  http://localhost:3001/api/agents/1/test-connection
```

### Deliverable Version Chain

When a deliverable is sent back for revision and re-executed (by the dispatcher or manually), the system maintains a version chain:

```
v1 (revised) ← v2 (revised) ← v3 (pending)
     ↑ parent_id     ↑ parent_id
```

Each deliverable has a `parent_id` linking to its previous version and an incrementing `version` number. The GET `/api/deliverables/:id` response includes a `versions` array showing the full history.

### Python SDK

```bash
pip install cavendo-engine
```

```python
from cavendo import CavendoClient

client = CavendoClient(
    url="http://localhost:3001",
    api_key="cav_ak_..."
)

task = client.tasks.next()
if task:
    client.deliverables.submit(
        task_id=task.id,  # Task is a typed object, use dot notation
        title="Research Report",
        content="## Findings\n..."
    )
```

## License

AGPL-3.0 - See [LICENSE](LICENSE) for details.

For alternative licensing arrangements, contact [sales@cavendo.com](mailto:sales@cavendo.com).

## Database

Cavendo Engine uses SQLite for simplicity. The database is automatically created on first run.

```bash
# Initialize fresh database
npm run db:init

# Database location
data/cavendo.db
```

### Schema Versioning

`server/db/schema.sql` is the canonical **v0.1.0 baseline schema**. On fresh installs, `db:init` runs this file directly — no migrations are needed. Future releases will include a `migrations/` directory for post-v0.1.0 schema upgrades.

## Troubleshooting

### Native Module Build Failures

If you see `ModuleNotFoundError: No module named 'distutils'` during `npm install`:

```bash
# macOS
brew install python-setuptools

# Linux/Windows
pip install setuptools
```

Then retry `npm install`.

## Roadmap

Future storage integrations planned:
- Google Drive (OAuth2)
- Microsoft OneDrive (OAuth2)
- Dropbox (OAuth2)

## Contributing

Contributions welcome! Please read our [contributing guidelines](CONTRIBUTING.md) before submitting PRs.

## Links

- **Website**: [cavendo.com](https://cavendo.com)
- **Product Page**: [cavendo.com/engine](https://cavendo.com/engine)
- **Documentation**: [docs/](https://github.com/Cavendo/Engine/tree/main/docs)
- **Issues**: [GitHub Issues](https://github.com/Cavendo/Engine/issues)
- **License**: [AGPL-3.0](LICENSE) — for alternative licensing, contact [sales@cavendo.com](mailto:sales@cavendo.com)
