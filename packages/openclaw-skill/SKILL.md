# Cavendo Engine Integration Skill

**Version:** 1.0.0  
**Author:** Cavendo  
**License:** MIT

## Overview

Integrate Cavendo Engine's AI agent workflow platform with OpenClaw, enabling your AI assistant to manage tasks, submit deliverables, and orchestrate multi-step workflows with human-in-the-loop review.

**What is Cavendo Engine?**

Cavendo Engine is a self-hosted platform for orchestrating AI agent workflows. It provides task assignment, deliverable review, knowledge base management, and automated content routing - all with human oversight.

**What does this skill do?**

This skill connects your OpenClaw assistant to a Cavendo Engine instance, allowing it to:
- Check for assigned tasks and claim new work
- Execute tasks using appropriate AI models
- Submit deliverables for human review
- Handle revision requests and feedback loops
- Search project knowledge bases for context
- Manage sprints and track progress

## Use Cases

### Content Creation
**"Check Cavendo for blog post tasks"**
- Assistant claims task, researches topic, generates draft
- You review and request revisions if needed
- Approved content auto-routes to WordPress/email/storage

### Research & Analysis
**"What's my next Cavendo task?"**
- Assistant finds market research task
- Gathers data, analyzes competitors, generates report
- You review findings before they're shared with clients

### Documentation
**"Work on the API docs task in Cavendo"**
- Assistant accesses knowledge base for context
- Generates comprehensive documentation
- You approve and it auto-publishes to docs site

### Daily Workflow Integration
- Morning briefing includes pending tasks
- Sprint check-ins show progress
- Auto-execution during idle time
- Notifications when deliverables are ready

## Prerequisites

### Required

1. **Cavendo Engine** - Running instance (v0.1.0 or higher)
   - Self-hosted: http://localhost:3001
   - Or cloud: https://portal.cavendo.net

2. **Python 3.8+** - For Cavendo Python SDK

3. **API Key** - Either:
   - **User Key** (`cav_uk_...`) - Acts as you personally
   - **Agent Key** (`cav_ak_...`) - Acts as dedicated AI agent

### Optional

- **OpenClaw Cron Jobs** - For automated task checking
- **Messaging Integration** - Signal/Slack for notifications

## Installation

### 1. Install Python Dependencies

```bash
cd ~/clawd/skills/cavendo-engine-1.0.0
pip install -r requirements.txt
```

This installs:
- `cavendo-engine` - Official Cavendo Python SDK
- `python-dotenv` - Environment variable management

### 2. Configure Environment

Create `.env` file in skill directory:

```bash
cp .env.example .env
nano .env
```

Set your configuration:

```env
# Cavendo Engine API endpoint
CAVENDO_URL=http://localhost:3001

# Your API key (get from Cavendo UI → Profile → API Keys)
CAVENDO_AGENT_KEY=cav_uk_your_key_here

# Optional: Auto-claim next task when checking
CAVENDO_AUTO_CLAIM=true

# Optional: Notification settings (for OpenClaw message tool)
CAVENDO_NOTIFY_CHANNEL=signal
CAVENDO_NOTIFY_TARGET=+1234567890
```

### 3. Test Connection

```bash
python scripts/check_connection.py
```

Expected output:
```
✅ Connected to Cavendo Engine
Authenticated as: Your Name
Agent/User ID: 1
```

## Usage

### Command Reference

This skill provides Python scripts that OpenClaw can invoke. Your AI assistant will call these automatically when you mention Cavendo-related tasks.

#### Check for Tasks
```bash
python scripts/check_tasks.py
```
Shows pending tasks assigned to you/your agent.

#### Claim Next Task
```bash
python scripts/claim_next.py
```
Claims the next available task and executes it.

#### Show Task Details
```bash
python scripts/show_task.py <task_id>
```
Displays full task information including context and history.

#### Submit Deliverable
```bash
python scripts/submit_deliverable.py <task_id> --title "Title" --content "Content"
```
Submit work for a task.

#### Review Deliverable
```bash
python scripts/review_deliverable.py <deliverable_id> --action approve
python scripts/review_deliverable.py <deliverable_id> --action revise --feedback "Please add more examples"
python scripts/review_deliverable.py <deliverable_id> --action reject
```

#### Sprint Summary
```bash
python scripts/sprint_summary.py
```
Shows current sprint progress and tasks.

#### Search Knowledge Base
```bash
python scripts/search_knowledge.py "query text" --project-id 1
```

### Conversational Usage

Once installed, your OpenClaw assistant can respond to natural language:

**You:** *"Check Cavendo for tasks"*  
**Assistant:** *[Runs check_tasks.py, reports findings]*

**You:** *"Claim the next Cavendo task"*  
**Assistant:** *[Runs claim_next.py, executes task, submits deliverable]*

**You:** *"Show me deliverable 42"*  
**Assistant:** *[Displays deliverable content and offers review options]*

**You:** *"Approve it"*  
**Assistant:** *[Approves deliverable, triggers any configured delivery routes]*

## Task Execution Flow

When your assistant claims and executes a task:

1. **Claim Task** - Marks task as assigned and in-progress
2. **Gather Context** - Retrieves:
   - Task description and requirements
   - Project knowledge base entries
   - Previous deliverables (for revision tasks)
   - User feedback (if revision requested)
3. **Execute** - Uses appropriate AI model (configurable):
   - Complex tasks → Claude Sonnet 4.6
   - Quick tasks → Claude Haiku 4.5
   - Research → OpenAI o1
4. **Submit Deliverable** - Creates deliverable with:
   - Title and content (markdown/HTML/text)
   - Summary for quick review
   - Token usage tracking
   - Metadata (sources, thinking process, etc.)
5. **Notify** - Sends notification via configured channel
6. **Await Review** - Task enters "review" status

## Deliverable Review Flow

When you review a submitted deliverable:

### Approve
- Deliverable marked as approved
- Delivery routes triggered (if configured):
  - Webhook to external systems
  - Email to recipients
  - Upload to S3/storage
  - Post to Slack/Discord
- Task marked as completed
- Knowledge base updated (if configured)

### Request Revision
- Feedback attached to deliverable
- Task returned to queue with revision context
- Previous deliverable marked as "revised"
- Next execution includes your feedback
- New deliverable linked to previous (version chain)

### Reject
- Deliverable marked as rejected
- Task can be reassigned or closed
- Feedback recorded for learning

## Integration with OpenClaw Crons

### Morning Briefing (6 AM)

Add to your morning briefing cron:

```python
# Get Cavendo task summary
result = exec("python ~/clawd/skills/cavendo-engine-1.0.0/scripts/check_tasks.py --format brief")
briefing += f"\n\n## 📋 Cavendo Tasks\n{result}"
```

### Sprint Check-In (2 PM, 6 PM)

Add to sprint check-in cron:

```python
# Get sprint progress
result = exec("python ~/clawd/skills/cavendo-engine-1.0.0/scripts/sprint_summary.py")
checkin += f"\n\n## Sprint Progress\n{result}"
```

### Auto-Worker Loop (Every 5-30 minutes)

Create a cron job that automatically claims and executes tasks:

```json
{
  "name": "Cavendo Auto-Worker",
  "schedule": {
    "kind": "every",
    "everyMs": 300000
  },
  "payload": {
    "kind": "agentTurn",
    "message": "Check Cavendo Engine for new tasks. If any are available, claim and execute the next one. If successful, submit the deliverable and notify me. If no tasks, respond with HEARTBEAT_OK."
  },
  "sessionTarget": "isolated"
}
```

## Configuration Options

### Model Selection

Edit `lib/config.py` to customize which AI models are used:

```python
MODEL_ROUTING = {
    "high_priority": "anthropic/claude-sonnet-4-6",
    "medium_priority": "anthropic/claude-haiku-4-5",
    "low_priority": "anthropic/claude-haiku-4-5",
    "research": "openai/o1",
    "coding": "anthropic/claude-opus-4-6",
}
```

### Notification Preferences

In `.env`:

```env
# Notify on every deliverable submission
CAVENDO_NOTIFY_ON_SUBMIT=true

# Notify only on high-priority tasks
CAVENDO_NOTIFY_PRIORITY_MIN=2

# Quiet hours (no notifications)
CAVENDO_QUIET_START=22:00
CAVENDO_QUIET_END=08:00
```

### Auto-Claim Behavior

```env
# Automatically claim next task when checking
CAVENDO_AUTO_CLAIM=true

# Only auto-claim high-priority tasks
CAVENDO_AUTO_CLAIM_PRIORITY_MIN=2

# Maximum concurrent tasks
CAVENDO_MAX_CONCURRENT=3
```

## Advanced Features

### Knowledge Base Search

Tasks automatically search the project knowledge base for relevant context:

```python
# In lib/task_executor.py
kb_results = client.knowledge.search(
    query=task.title + " " + task.description,
    project_id=task.project_id,
    limit=5
)
```

You can also manually search:

```bash
python scripts/search_knowledge.py "product pricing strategy" --project-id 1
```

### Deliverable Metadata

Deliverables include rich metadata for tracking:

```json
{
  "metadata": {
    "model_used": "claude-sonnet-3.5",
    "execution_time_seconds": 12.4,
    "sources": ["knowledge_base_entry_3", "previous_deliverable_15"],
    "thinking_process": "First researched competitors, then...",
    "confidence_score": 0.85
  }
}
```

### Version Chains

When revisions are requested, deliverables link to their previous versions:

```
v1 (revised) ← v2 (revised) ← v3 (approved)
     ↑ parent_id     ↑ parent_id
```

Fetch version history:

```bash
python scripts/show_deliverable.py 42 --show-versions
```

### Sprint Metrics

Track sprint velocity and completion rates:

```bash
python scripts/sprint_summary.py --sprint-id 5 --detailed
```

Output:
```
Sprint: Sprint 5
Status: Active (Day 3 of 14)

Tasks: 7 total
✅ Completed: 3 (43%)
🔄 In Progress: 2 (29%)
⏳ Pending: 2 (29%)

Velocity: 1.0 tasks/day
Projected Completion: On track

Deliverables:
• 3 approved
• 1 pending review
• 1 revision requested
```

## Troubleshooting

### Connection Issues

**Error:** `Connection refused to http://localhost:3001`

**Solution:**
1. Verify Cavendo Engine is running: `curl http://localhost:3001/api/health`
2. Check `CAVENDO_URL` in `.env`
3. If using cloud, ensure URL includes `https://`

### Authentication Errors

**Error:** `401 Unauthorized`

**Solution:**
1. Verify your API key is correct in `.env`
2. Check key hasn't been revoked in Cavendo UI → Profile → API Keys
3. Ensure key format: `cav_uk_...` (user) or `cav_ak_...` (agent)

### No Tasks Found

**Error:** `No tasks available`

**Solution:**
1. Check Cavendo UI - are tasks created?
2. Verify tasks are assigned to your user/agent
3. Check task status filter: `--status pending,assigned`

### Import Errors

**Error:** `ModuleNotFoundError: No module named 'cavendo'`

**Solution:**
```bash
pip install -r requirements.txt
```

## Security Best Practices

### API Key Storage

- **Never commit** `.env` to version control
- Use `.env.example` for templates (without real keys)
- Rotate keys periodically
- Use user keys (`cav_uk_`) for personal use
- Use agent keys (`cav_ak_`) for automation

### Permissions

- Grant minimum necessary permissions
- Use scoped agent keys when possible
- Review agent activity logs regularly

### Data Privacy

- Cavendo Engine runs self-hosted (your infrastructure)
- No data sent to third parties (except chosen AI providers)
- All deliverables stored in your database
- Configure delivery routes carefully (review destinations)

## Examples

### Example 1: Content Creation Workflow

```bash
# Morning: Check for content tasks
python scripts/check_tasks.py --project "Content"

# Claim the blog post task
python scripts/claim_next.py

# [Assistant executes, generates content]

# Review the deliverable
python scripts/show_deliverable.py 123

# Request minor revisions
python scripts/review_deliverable.py 123 --action revise --feedback "Add more examples in section 2"

# [Assistant re-executes with feedback]

# Approve final version
python scripts/review_deliverable.py 124 --action approve

# [Content auto-routes to configured destinations]
```

### Example 2: Research Task

```bash
# Check for research tasks
python scripts/check_tasks.py --priority high

# Claim research task
python scripts/claim_next.py

# [Assistant searches KB, gathers data, generates report]

# Review and approve
python scripts/review_deliverable.py 125 --action approve

# [Report delivered via configured route]
```

### Example 3: Sprint Planning

```bash
# Create sprint
curl -X POST http://localhost:3001/api/sprints \
  -H "X-Agent-Key: $CAVENDO_AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Sprint 1",
    "start_date": "2026-03-01",
    "end_date": "2026-03-15",
    "project_id": 1
  }'

# Add tasks to sprint via Cavendo UI

# Check progress throughout sprint
python scripts/sprint_summary.py

# End of sprint: Review metrics
python scripts/sprint_summary.py --detailed
```

## Roadmap

### v1.1 (Planned)
- Task templates (create multiple similar tasks at once)
- Automated quality scoring (rate deliverables before submission)
- Multi-agent coordination (tasks that require multiple agents)
- Richer notification templates

### v1.2 (Planned)
- Interactive deliverable editing (request specific changes inline)
- Knowledge base auto-updates (approved content becomes future context)
- Advanced routing rules (conditional delivery based on metadata)
- Integration with more messaging platforms

### v2.0 (Future)
- Visual workflow builder
- A/B testing for deliverables
- Sentiment analysis on feedback
- Predictive task duration estimates

## Contributing

This skill is open source. Contributions welcome!

**Reporting Issues:**
- GitHub: https://github.com/cavendo/openclaw-cavendo-skill
- Discord: https://discord.gg/cavendo

**Pull Requests:**
- Fork the repository
- Create feature branch
- Add tests for new functionality
- Submit PR with clear description

## License

MIT License - see LICENSE file for details.

## Support

- **Documentation**: https://docs.cavendo.net
- **Community**: https://discord.gg/cavendo
- **Email**: support@cavendo.net

## Credits

Created by the Cavendo team.

Built on:
- Cavendo Engine - https://github.com/Cavendo/Engine
- OpenClaw - https://github.com/openclaw/openclaw
- Anthropic Claude - https://anthropic.com

---

**Happy automating!** 🤖📋✨
