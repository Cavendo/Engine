# Changelog

All notable changes to Cavendo Engine will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-02-20

### Added

- **Local Model Support** — New `openai_compatible` provider for Ollama, LM Studio, vLLM, LocalAI, and any OpenAI-compatible endpoint
  - Base URL configuration with UI presets (Ollama, LM Studio, vLLM)
  - API key optional (most local models don't require auth)
  - Free-text model input with starter suggestions
  - Origin-only URL enforcement (`/v1/chat/completions` appended automatically)
- **Endpoint Security** — Two-tier validation for provider base URLs
  - Default: only local/allowlisted endpoints permitted
  - Override mode (`ALLOW_CUSTOM_PROVIDER_BASE_URLS=true`): remote HTTPS endpoints allowed
  - Allowlist support (`PROVIDER_BASE_URL_ALLOWLIST`)
  - DNS-based locality checks with split-horizon prevention
- **Shared Network Utilities** — Extracted IP classification into `server/utils/networkUtils.js` (shared by webhooks and provider endpoint validation)

## [0.1.0] - 2026-02-18

### Added

- **Core Platform**
  - User authentication with session management
  - Role-based access control (admin, reviewer, viewer)
  - Agent registration and API key management
  - User API keys for personal MCP access

- **Agent Profiles**
  - Agent specializations metadata (business lines, content types, capabilities)
  - Custom metadata for extensibility
  - Active task count tracking (maintained by engine)
  - Agent status management (active, paused, disabled)
  - Agent execution via Anthropic, OpenAI, and OpenAI-compatible providers

- **Task Management**
  - Create, update, and delete tasks
  - Task assignment to agents
  - Priority levels (urgent, high, medium, low)
  - Task status workflow (pending → assigned → in_progress → review → completed)
  - Task claiming by agents
  - Progress logging with percentage tracking
  - Bulk operations (create, update, delete multiple tasks)
  - Task tags for routing and categorization

- **Task Routing**
  - Project-level routing rules with priority ordering
  - Tag-based and priority-based conditions
  - Capability-based agent assignment
  - Assignment strategies: least_busy, round_robin, first_available, random
  - Fallback agent support
  - Dry-run routing test endpoint
  - Routing decision audit trail on tasks

- **Sprint/Milestone Planning**
  - Create sprints with start/end dates
  - Add/remove tasks from sprints
  - Sprint status workflow (planning → active → completed)
  - Task summary per sprint

- **Deliverables**
  - Submit deliverables for tasks
  - Support for markdown, HTML, JSON, text, code content
  - File attachments and follow-up actions
  - Summary field for deliverable descriptions
  - Version history for revisions
  - Standalone deliverables (without task linkage)
  - Token usage tracking (input/output tokens, provider, model)

- **Review Workflow**
  - Approve, reject, or request revision
  - Feedback mechanism for agents
  - Deliverable comments/discussion

- **Delivery Routes**
  - Project-level routes for auto-dispatching approved content
  - Trigger events: deliverable.approved, deliverable.submitted, revision_requested, rejected
  - Webhook destinations with HMAC-SHA256 signing
  - Email destinations with multi-provider support (SMTP, SendGrid, Mailjet, Postmark, AWS SES)
  - Handlebars templates for payload and subject customization
  - Field mapping for flexible payload structure
  - Trigger conditions for filtered dispatch
  - Retry policies with configurable attempts
  - Delivery logging with status tracking

- **Knowledge Base**
  - Project-scoped knowledge documents
  - Document types: documentation, guideline, template, example, reference
  - Full-text search
  - Automatic inclusion in task context

- **Webhooks**
  - Event notifications (task, deliverable events)
  - HMAC-SHA256 signature verification
  - Retry with exponential backoff
  - Delivery history and manual retry

- **Activity Logging**
  - Universal entity activity log
  - Tracks creates, updates, status changes, assignments
  - Queryable by entity type and ID

- **Agent Metrics**
  - Tasks completed count
  - Deliverable approval rates
  - First-time approval rate
  - Average completion time

- **Comments/Discussion**
  - Comments on tasks and deliverables
  - Support for both user and agent authors

- **Integrations**
  - MCP Server for Claude Desktop integration (12 tools)
  - Python SDK for agent development
  - OpenAPI 3.0 specification

- **Security**
  - CSRF protection
  - Rate limiting
  - Secure session management
  - API key hashing with bcrypt
  - Provider API key encryption (AES-256-GCM)
  - Sensitive data redaction in API responses for non-admin users

### Documentation

- Quick start guide
- Architecture overview with data flow diagrams
- Full API reference (REST endpoints)
- OpenAPI 3.0 specification
- Integration guides (MCP Server, Python SDK)
- Agent management guide
- Delivery routes configuration guide
- Webhook setup guide
- Knowledge base usage guide
- Contributing guidelines
- Security policy
