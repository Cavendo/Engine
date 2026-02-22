# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with the Cavendo Engine codebase.

## Project Overview

Cavendo Engine is an open-source agent workflow platform that enables AI agents to receive tasks, submit deliverables, and get human feedback. It's the foundation for human-in-the-loop AI workflows.

## Tech Stack

- **Backend**: Node.js 18+ / Express 4.x
- **Database**: SQLite (better-sqlite3)
- **Frontend**: React 18 / Vite / Tailwind CSS 3
- **Auth**: Session-based (users) + API keys (agents)
- **Package Manager**: npm

## Commands

```bash
# Install all dependencies
npm install && cd ui && npm install && cd ..

# Initialize database
node server/db/init.js

# Start development (server + UI)
npm run dev

# Start server only
npm run server:dev

# Start UI only
npm run ui:dev

# Build for production
npm run build

# Run tests
npm test

```

## Architecture

### Server Structure

```
server/
├── env.js                # Env bootstrap (.env loading/generation, import-time side effect)
├── app.js                # createApp(options?) factory, returns { app, start, stop }
├── index.js              # Thin bootstrap: imports createApp, calls start(), signal handlers
├── db/
│   ├── connection.js     # SQLite connection
│   ├── schema.sql        # Canonical v0.1.0 baseline schema (fresh installs)
│   ├── init.js           # Database initialization (runs schema.sql)
│   └── migrations/       # Future post-v0.1.0 upgrade scripts
├── routes/
│   ├── agents.js         # Agent CRUD + API keys + execution
│   ├── users.js          # User CRUD + personal API keys (create auto-links human agent)
│   ├── tasks.js          # Task management + routing
│   ├── deliverables.js   # Submission + review
│   ├── projects.js       # Project management + routing rules
│   ├── sprints.js        # Sprint/milestone management
│   ├── comments.js       # Comments on tasks/deliverables
│   ├── routes.js         # Delivery route CRUD + logs
│   ├── knowledge.js      # Knowledge base
│   ├── webhooks.js       # Webhook configuration
│   ├── auth.js           # User authentication
│   └── activity.js       # Activity log
├── middleware/
│   ├── agentAuth.js      # X-Agent-Key validation (user + agent keys)
│   └── userAuth.js       # Session validation
├── services/
│   ├── webhooks.js       # Webhook delivery
│   ├── agentExecutor.js  # AI provider execution (Anthropic/OpenAI/OpenAI-compatible)
│   ├── taskDispatcher.js # Background auto-execution polling service
│   ├── taskRouter.js     # Task routing rule evaluation + agent matching
│   ├── activityLogger.js # Universal activity log (fire-and-forget)
│   ├── routeDispatcher.js # Delivery route dispatch
│   └── emailProvider.js  # Multi-provider email delivery
└── utils/
    ├── crypto.js         # Hashing, encryption, signatures
    ├── validation.js     # Zod schemas for routing rules
    ├── response.js       # API response helpers + route formatting
    ├── networkUtils.js   # Shared IP classification (private/local detection)
    └── providerEndpoint.js # Provider base URL validation + security
```

### UI Structure

```
ui/
├── src/
│   ├── App.jsx           # Routes + auth wrapper
│   ├── main.jsx          # Entry point
│   ├── pages/            # Route components
│   ├── components/       # Reusable UI components
│   ├── hooks/            # React hooks (useAuth)
│   └── lib/              # API client
└── index.html
```

## Key Concepts

### API Key Types

| Key Type | Format | Identity | Use Case |
|----------|--------|----------|----------|
| User Key | `cav_uk_...` | Acts as the user | Personal MCP access |
| Agent Key | `cav_ak_...` | Agent identity | Automated bots |

Both authenticate via `X-Agent-Key` header.

### Agent Execution

Agents can execute tasks via AI provider APIs:
- **Anthropic**: Claude Opus/Sonnet/Haiku
- **OpenAI**: GPT-4o/Turbo/3.5
- **OpenAI-Compatible**: Ollama, LM Studio, vLLM, any `/v1/chat/completions` endpoint
- Execution modes: manual, auto, polling, human (human workers — dispatcher skips, notified via delivery routes)
- Provider API keys stored encrypted (AES-256-GCM)

### Task Workflow

`pending` → `assigned` → `in_progress` → `review` → `completed`

### Deliverable Review

`pending` → `approved` | `revision_requested` | `rejected`

When a revision is submitted, the original deliverable transitions to `revised`:
`revision_requested` → `revised` (original) + new `pending` deliverable (with `parent_id` link)

### Task Dispatcher

Background service that auto-executes tasks assigned to agents with `execution_mode = 'auto'`:
- Polls on configurable interval (default 30s, `DISPATCHER_INTERVAL_MS`)
- Respects agent capacity (`active_task_count < max_concurrent_tasks`)
- Manages `active_task_count` lifecycle (increment on start, decrement on completion/failure)
- Handles revision chains: new deliverables link to previous via `parent_id`, old status set to `revised`
- Category-based error cooldowns: auth/config (5min), timeout/overloaded (10min), rate_limited (60min), unknown (6hr)
- Updating agent credentials auto-clears stuck task errors; `POST /api/tasks/:id/retry` for manual clear
- Logs warnings for unrouted tasks (no rules or default agent configured)
- Logs to both `agent_activity` and `activity_log` tables
- Manual execution via `executeTaskNow()` for UI "Execute Now" button

### Webhook & Route Events (20 total)

- Deliverable: `approved`, `submitted`, `revision_requested`, `rejected`
- Task: `created`, `assigned`, `completed`, `status_changed`, `overdue`, `updated`, `claimed`, `progress_updated`, `routing_failed`, `execution_failed`
- Other: `review.completed`, `agent.registered`, `agent.status_changed`, `project.created`, `project.knowledge_updated`, `knowledge.updated`
- Canonical list: `TRIGGER_EVENTS` in `server/utils/validation.js`

## Database

SQLite database at `data/cavendo.db`. Key tables:

- `agents` - Registered AI agents (includes execution config, capacity, specializations)
- `agent_keys` - Agent API keys (hashed)
- `user_keys` - Personal user API keys (hashed)
- `tasks` - Work items (with tags, routing decision tracking, required_capabilities)
- `deliverables` - Submitted work (with files, actions, summary, version chain via parent_id)
- `projects` - Organizational containers (with task_routing_rules, default_agent_id)
- `sprints` - Sprint/milestone management
- `knowledge` - Project documentation
- `comments` - Threaded discussions on tasks and deliverables (polymorphic)
- `task_progress` - Progress updates during task execution
- `webhooks` - Outbound webhook configs
- `webhook_deliveries` - Delivery log
- `agent_activity` - Agent-scoped audit trail
- `activity_log` - Universal entity activity log (deliverables + tasks)
- `delivery_logs` - Route dispatch delivery records
- `routes` - Delivery route configurations
- `users` / `sessions` - Admin UI auth

### New Agent Columns

```sql
owner_user_id          -- Link agent to user for "my tasks"
provider               -- 'anthropic', 'openai', or 'openai_compatible'
provider_api_key_encrypted  -- AES-256-GCM encrypted
provider_api_key_iv    -- Initialization vector
provider_model         -- Model ID
provider_base_url      -- Custom API base URL origin (openai_compatible)
provider_label         -- Display label (e.g., "Ollama", "LM Studio")
system_prompt          -- Custom instructions
execution_mode         -- 'manual', 'auto', 'polling', 'human'
```

## Development Notes

- Server runs on port 3001
- UI dev server on port 5173 (proxies /api to 3001)
- Default admin: admin@cavendo.local / admin
- Agent API keys: `cav_ak_...`
- User API keys: `cav_uk_...`
- Webhook secrets: `whsec_...`
- Set `ENCRYPTION_KEY` env var for production encryption

## Important Files

- `server/app.js` - App factory (`createApp`) with lifecycle hooks and start/stop
- `server/env.js` - Env bootstrap (`.env` loading/generation at import time)
- `server/middleware/agentAuth.js` - Agent + user key authentication
- `server/routes/users.js` - User CRUD + API keys (creating a user auto-creates a linked human agent)
- `server/routes/agents.js` - Agent CRUD + execution endpoints
- `server/services/agentExecutor.js` - AI provider execution
- `server/utils/crypto.js` - Encryption utilities
- `server/services/taskDispatcher.js` - Background auto-execution service (polling, capacity, retry)
- `server/utils/providerEndpoint.js` - Provider base URL validation + endpoint security
- `server/utils/networkUtils.js` - Shared IP/hostname classification
- `server/services/webhooks.js` - Webhook delivery with retry
- `server/services/activityLogger.js` - Universal activity logging
- `server/services/routeDispatcher.js` - Delivery route dispatch + logging
- `server/services/taskRouter.js` - Task routing rule evaluation + agent matching
- `server/routes/tasks.js` - Task context bundle endpoint
- `ui/src/lib/api.js` - Frontend API client

## Documentation

- `docs/api.md` - Full API reference
- `docs/api/` - Endpoint-specific docs (agents, tasks, deliverables, routes, sprints, comments)
- `docs/api/openapi.yaml` - OpenAPI 3.0 specification
- `docs/guides/` - Architecture, quickstart, task routing, webhooks, knowledge base
- `docs/integrations/` - MCP Server, Python SDK
- `docs/agent-management.md` - Agent setup guide

## Security Notes

- Passwords use bcrypt with 12 rounds
- API keys are hashed with SHA-256
- Provider API keys encrypted with AES-256-GCM
- Webhook payloads are signed with HMAC-SHA256
- Session cookies are httpOnly and secure in production
