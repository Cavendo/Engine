# Cavendo Engine - OpenClaw Integration Skill

Connect your OpenClaw AI assistant to Cavendo Engine for structured AI workflow management with human-in-the-loop review.

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

## Available Scripts

| Script | Status | Description |
|--------|--------|-------------|
| `scripts/check_connection.py` | Included | Test API connectivity |
| `scripts/check_tasks.py` | Included | List pending tasks |

Additional scripts (`claim_next.py`, `submit_deliverable.py`, `review_deliverable.py`, `sprint_summary.py`, `search_knowledge.py`) are documented in [SKILL.md](SKILL.md) and planned for a future release. The Python SDK provides all the underlying functionality — these scripts add CLI convenience.

## What This Does

- Check for and list assigned tasks from Cavendo Engine
- Format task lists by priority for quick review
- Integrate with OpenClaw cron jobs for automated workflows
- Provide a client wrapper with model routing by task priority

## Documentation

See [SKILL.md](SKILL.md) for complete documentation including:
- Setup instructions
- Configuration options
- Command reference
- Integration examples
- Troubleshooting guide

## Requirements

- Python 3.9+
- Cavendo Engine v0.1.0+
- OpenClaw (optional, for cron integration)

## License

MIT - see LICENSE file
