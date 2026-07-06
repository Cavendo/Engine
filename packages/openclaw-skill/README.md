# Cavendo Engine - OpenClaw Integration Skill

Connect your OpenClaw runtime to Cavendo Engine as a first-class external employee with structured task intake, context retrieval, lease heartbeat, and human-in-the-loop review.

## Quick Start

1. **Install dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

2. **Configure:**
   ```bash
   cp .env.example .env
   # Edit .env with your Cavendo URL and API key
   ```

3. **Test connection:**
   ```bash
   python scripts/check_connection.py
   ```

4. **Check for tasks:**
   ```bash
   python scripts/check_tasks.py
   ```

5. **Read the external worker contract:**
   Start with [`../../docs/external-agents.md`](../../docs/external-agents.md) so your runtime follows the current lease and heartbeat flow.

## Available Scripts

| Script | Status | Description |
|--------|--------|-------------|
| `scripts/check_connection.py` | Included | Test API connectivity |
| `scripts/check_tasks.py` | Included | List pending tasks |

Additional scripts (`claim_next.py`, `submit_deliverable.py`, `review_deliverable.py`, `sprint_summary.py`, `search_knowledge.py`) are documented in [SKILL.md](SKILL.md) and planned for a future release. The Python SDK provides all the underlying functionality and lets you implement the full external employee loop today.

## What This Does

- Poll Cavendo for assigned tasks owned by the external employee
- Claim execution leases before starting work
- Fetch the full task context bundle before generation
- Heartbeat while long-running work is in progress
- Push lifecycle updates and final results back into Cavendo
- Keep OpenClaw inside Cavendo's review-first operating model

## External Employee Workflow

OpenClaw should behave like an external employee, not like a side channel that bypasses Cavendo.

Recommended loop:

1. `POST /api/agents/me/tasks/poll`
2. `POST /api/agents/me/tasks/:taskId/claim`
3. `GET /api/tasks/:taskId/context`
4. Run the task locally in OpenClaw
5. `POST /api/agents/me/tasks/:taskId/heartbeat` every 60 to 120 seconds while running
6. `POST /api/tasks/:taskId/external-status` when execution meaningfully changes
7. `POST /api/tasks/:taskId/result` when output is ready for review

Use `external-status` for lifecycle transitions such as `running`, `blocked`, `needs_input`, `failed`, and `submitted`. Use `heartbeat` only to keep the lease active.

## What OpenClaw Should Do

- only take tasks assigned to its external employee
- read the full task context bundle before generating
- preserve a stable `externalRunId` per execution attempt
- request review for human-facing outputs by default
- send useful status and error messages back to Cavendo

## What OpenClaw Should Not Do

- do not work tasks without first claiming the lease
- do not hold a lease without heartbeating
- do not publish directly to external systems before Cavendo review unless the workflow explicitly allows it
- do not assume shared context is the full context surface; project context may also apply

## Documentation

See [SKILL.md](SKILL.md) for complete documentation including:
- Setup instructions
- Configuration options
- Command reference
- Integration examples
- Troubleshooting guide

Also see:

- [External employee contract](../../docs/external-agents.md)
- [MCP integration guide](../../docs/integrations/mcp.md)

## Requirements

- Python 3.9+
- Cavendo Engine v0.1.0+
- OpenClaw (optional, for cron integration)

## License

MIT - see LICENSE file
