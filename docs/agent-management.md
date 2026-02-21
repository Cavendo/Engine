# Agent Management

This guide covers creating, configuring, and managing AI agents and users in Cavendo Engine.

## Overview

### Users and Agents

Every **user** created in Cavendo automatically gets a linked **human agent** (`execution_mode: 'human'`). This means users appear as task assignees alongside AI agents — the same routing, assignment, and deliverable workflow applies to both.

- **Deactivating a user** sets their linked agent to `disabled` (no new task assignments)
- **Deleting a user** removes their linked agent
- **Renaming a user** updates their linked agent name

Users can generate an **MCP key** to use AI tools (Claude Desktop, ChatGPT) to interact with their assigned tasks.

### API Key Types

Cavendo Engine supports two types of API keys for authentication:

| Key Type | Format | Identity | Use Case |
|----------|--------|----------|----------|
| **User Key** | `cav_uk_...` | Acts as the user | Personal MCP access (Claude Desktop, Cursor) |
| **Agent Key** | `cav_ak_...` | Agent identity | Automated bots, audit trail, auto-execution |

## Authentication for Admin Endpoints

All admin endpoints require session authentication with a CSRF token:

1. Log in via `/api/auth/login` to get your session cookie and `csrfToken`
2. Include the session cookie with `-b cookies.txt`
3. Include the CSRF token with `-H "X-CSRF-Token: YOUR_TOKEN"` for POST/PATCH/PUT/DELETE requests

## User Keys (Personal API Access)

User keys allow you to access Cavendo via MCP tools (Claude Desktop, Cursor, etc.) as yourself.

### Generate a User Key

```bash
# POST /api/users/me/keys (requires session auth + CSRF)
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  -d '{"name": "Claude Desktop"}' \
  http://localhost:3001/api/users/me/keys
```

Response:
```json
{
  "id": 1,
  "apiKey": "cav_uk_abc123...",
  "prefix": "cav_uk_abc1234",
  "name": "Claude Desktop",
  "warning": "Store this key securely - it cannot be retrieved again"
}
```

### List User Keys

```bash
# GET /api/users/me/keys (requires session auth)
curl -b cookies.txt \
  http://localhost:3001/api/users/me/keys
```

### Revoke a User Key

```bash
# DELETE /api/users/me/keys/:keyId (requires session auth + CSRF)
curl -X DELETE \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  http://localhost:3001/api/users/me/keys/1
```

### MCP Configuration

Configure your MCP client with your user key:

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

When using a user key:
- "My tasks" returns tasks assigned to YOU
- Deliverables show "submitted by [Your Name]"
- Actions are logged under your user account

## Agent Keys (Bot Identity)

Agent keys give AI bots their own identity, separate from any user.

### Create an Agent

```bash
# POST /api/agents (requires admin session + CSRF)
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  -d '{
    "name": "Code Reviewer",
    "type": "autonomous",
    "description": "Reviews code and suggests improvements",
    "capabilities": ["code", "review"],
    "maxConcurrentTasks": 3
  }' \
  http://localhost:3001/api/agents
```

### Generate Agent Key

```bash
# POST /api/agents/:id/keys (requires admin session + CSRF)
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  -d '{
    "name": "Production Key",
    "scopes": ["read", "write"]
  }' \
  http://localhost:3001/api/agents/1/keys
```

### Link Agent to User

You can link an agent to a user so "my tasks" queries return that user's tasks:

```bash
# PUT /api/agents/:id/owner (requires admin session + CSRF)
curl -X PUT \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  -d '{"userId": 1}' \
  http://localhost:3001/api/agents/1/owner
```

When linked:
- "My tasks" returns the linked user's tasks
- Deliverables still show "submitted by [Agent Name]"
- Useful when an AI assistant works on behalf of a specific user

## Agent Execution

Agents can automatically execute tasks using AI provider APIs.

### Supported Providers

| Provider | Models | API Key |
|----------|--------|---------|
| Anthropic | claude-opus-4-20250514, claude-sonnet-4-20250514, claude-haiku-4-20250514 | Required |
| OpenAI | gpt-4o, gpt-4-turbo, gpt-3.5-turbo | Required |
| OpenAI-Compatible | Any model tag (e.g., llama3.2:latest, qwen2.5:latest, mistral:latest) | Optional |

### Configure Execution

```bash
# PATCH /api/agents/:id/execution (requires admin session + CSRF)
curl -X PATCH \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  -d '{
    "provider": "anthropic",
    "providerApiKey": "sk-ant-...",
    "providerModel": "claude-opus-4-20250514",
    "systemPrompt": "You are a code review expert...",
    "executionMode": "manual",
    "maxTokens": 4096,
    "temperature": 0.7
  }' \
  http://localhost:3001/api/agents/1/execution
```

#### Local Model Example (Ollama)

```bash
curl -X PATCH \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  -d '{
    "provider": "openai_compatible",
    "providerModel": "llama3.2:latest",
    "providerBaseUrl": "http://localhost:11434",
    "providerLabel": "Ollama",
    "executionMode": "manual"
  }' \
  http://localhost:3001/api/agents/1/execution
```

No API key is needed — most local model servers don't require authentication.

> **Known gotcha:** The model name must match the exact tag in your local runtime. Run `ollama list` (or the equivalent for your server) to see available tags. A mismatch like `llama3.2` vs `llama3.2:latest` will return a model-not-found error.

> **Provider boundary:** `providerBaseUrl` is only accepted for `openai_compatible`. Sending it with `provider: "openai"` returns a 400 error — use `openai_compatible` instead.

### Local Model Setup

Common local model servers and their default ports:

| Server | Default Base URL | Install |
|--------|-----------------|---------|
| Ollama | `http://localhost:11434` | [ollama.com](https://ollama.com) |
| LM Studio | `http://localhost:1234` | [lmstudio.ai](https://lmstudio.ai) |
| vLLM | `http://localhost:8000` | `pip install vllm` |
| LocalAI | `http://localhost:8080` | [localai.io](https://localai.io) |

The UI provides one-click presets for Ollama, LM Studio, and vLLM.

#### Endpoint Security

By default, only local and explicitly allowlisted endpoints are permitted. This prevents accidental SSRF through the provider base URL.

**Environment variables** (`.env`):

```bash
# Allow remote HTTPS endpoints (default: false)
ALLOW_CUSTOM_PROVIDER_BASE_URLS=true

# Allowlist specific hosts (comma-separated, supports host:port and IPv6 bracket notation)
PROVIDER_BASE_URL_ALLOWLIST=gpu-box.lan,myserver.local:11434,[fd12::1]:8080

# Default base URL when agent has no base URL set (default: http://localhost:11434)
OPENAI_COMPAT_DEFAULT_BASE_URL=http://localhost:11434
```

**Security rules:**
- **Default mode**: Only `localhost`, `127.0.0.1`, private RFC1918 IPs, and allowlisted hosts are permitted (HTTP or HTTPS)
- **Override mode** (`ALLOW_CUSTOM_PROVIDER_BASE_URLS=true`): Remote endpoints allowed but **must use HTTPS**
- URLs must be origin-only (no path, query, or fragment) — `/v1/chat/completions` is appended automatically
- DNS resolution checks all resolved IPs; mixed public/private results are treated as non-local

### Execution Modes

| Mode | Description |
|------|-------------|
| `manual` | Admin triggers execution via UI "Execute Now" button or API |
| `auto` | Task Dispatcher automatically executes when tasks are assigned |
| `polling` | Agent periodically checks for new tasks (external agent, not dispatcher) |
| `human` | Human worker — dispatcher skips, notifications via delivery routes |

#### Task Dispatcher (Auto Mode)

When an agent is set to `auto` execution mode, the built-in Task Dispatcher background service will:

1. **Poll** for eligible tasks every 30 seconds (configurable via `DISPATCHER_INTERVAL_MS`)
2. **Check capacity** — only executes if `active_task_count < max_concurrent_tasks`
3. **Gather context** — pulls project knowledge, previous deliverables/feedback, and related tasks
4. **Execute** via the configured AI provider (Anthropic/OpenAI/OpenAI-compatible)
5. **Create deliverable** — stores the response as a pending deliverable for review
6. **Handle revisions** — when re-executing a task sent back for revision, automatically links the new deliverable to the previous version and marks the old one as `revised`

**Capacity management:** The dispatcher increments `active_task_count` when starting execution and decrements it on completion (success or failure), preventing agents from being overloaded.

**Error handling:** Errors are categorized and retried with appropriate cooldowns:

| Category | Cooldown | Examples |
|---|---|---|
| `config_error`, `auth_error` | 5 min | Bad API key, encryption issues |
| `timeout`, `overloaded` | 10 min | Provider slow or at capacity |
| `rate_limited` | 60 min | Quota window exceeded |
| `quota_exceeded`, `bad_request`, `unknown` | 6 hours | Needs human intervention |

**Immediate recovery:** Updating an agent's API key or provider automatically clears execution errors on all stuck tasks for that agent. Use `POST /api/tasks/:id/retry` to manually clear a specific task's error.

**Configuration:**
```bash
DISPATCHER_INTERVAL_MS=30000   # Poll interval (default: 30s)
DISPATCHER_BATCH_SIZE=5        # Max tasks per cycle (default: 5)
```

### Test Connection

Before executing, test the provider connection:

```bash
# POST /api/agents/:id/test-connection (requires admin session + CSRF)
curl -X POST \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  http://localhost:3001/api/agents/1/test-connection
```

Or test with a new key before saving:

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  -d '{
    "provider": "anthropic",
    "apiKey": "sk-ant-...",
    "model": "claude-opus-4-20250514"
  }' \
  http://localhost:3001/api/agents/1/test-connection
```

### Execute Task

```bash
# POST /api/agents/:id/execute (requires admin session + CSRF)
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  -d '{"taskId": 123}' \
  http://localhost:3001/api/agents/1/execute
```

Response:
```json
{
  "success": true,
  "deliverableId": 456,
  "content": "## Code Review\n...",
  "usage": {
    "inputTokens": 1234,
    "outputTokens": 567
  }
}
```

## Security

### API Key Storage

- Agent API keys are stored as SHA-256 hashes
- Provider API keys are encrypted with AES-256-GCM
- Set `ENCRYPTION_KEY` environment variable for production

### Key Rotation

Regularly rotate API keys:

1. Generate new key
2. Update MCP/client configuration
3. Revoke old key

### Scopes

Agent keys can be limited to specific scopes:

| Scope | Permissions |
|-------|-------------|
| `read` | View tasks, projects, knowledge |
| `write` | Submit deliverables, update task status |
| `webhook:create` | Register and manage webhooks |
| `*` | All permissions |

## Database Schema

### user_keys Table

```sql
CREATE TABLE user_keys (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  name TEXT,
  last_used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### agents Table (Execution Columns)

```sql
ALTER TABLE agents ADD COLUMN owner_user_id INTEGER REFERENCES users(id);
ALTER TABLE agents ADD COLUMN provider TEXT;
ALTER TABLE agents ADD COLUMN provider_api_key_encrypted TEXT;
ALTER TABLE agents ADD COLUMN provider_api_key_iv TEXT;
ALTER TABLE agents ADD COLUMN provider_model TEXT;
ALTER TABLE agents ADD COLUMN provider_base_url TEXT;
ALTER TABLE agents ADD COLUMN provider_label TEXT;
ALTER TABLE agents ADD COLUMN system_prompt TEXT;
ALTER TABLE agents ADD COLUMN execution_mode TEXT DEFAULT 'manual';
ALTER TABLE agents ADD COLUMN max_tokens INTEGER DEFAULT 4096;
ALTER TABLE agents ADD COLUMN temperature REAL DEFAULT 0.7;
```
