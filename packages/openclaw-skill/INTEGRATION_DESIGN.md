# OpenClaw + Cavendo Engine: Integration Design

**Version:** 1.0.0  
**Date:** February 17, 2026  
**Author:** Cavendo

---

## Executive Summary

This document outlines the architectural design for integrating Cavendo Engine (AI agent workflow platform) with OpenClaw (AI assistant framework). The integration enables structured, human-reviewed AI workflows through conversational interfaces.

**Key Benefits:**
- Structured task management for AI work
- Human-in-the-loop review before content goes live
- Automated content routing to multiple destinations
- Full audit trail and version history
- Sprint planning and progress tracking
- Knowledge base accumulation over time

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│                         USER (Jonathan)                     │
│                                                             │
│  "Check Cavendo for tasks"  │  "Approve deliverable 42"    │
│                             │                               │
└──────────────┬──────────────┴───────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│                    OpenClaw (Clawd AI)                       │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Cavendo Engine Skill (this skill)                    │  │
│  │  - Natural language → API calls                        │  │
│  │  - Task execution logic                                │  │
│  │  - Response formatting                                 │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
└──────────────┬───────────────────────────────────────────────┘
               │
               │ Cavendo Python SDK
               │
               ▼
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│                   Cavendo Engine API                         │
│                    (localhost:3001)                          │
│                                                              │
│  ┌────────────┐  ┌─────────────┐  ┌──────────────┐          │
│  │   Tasks    │  │ Deliverables│  │  Knowledge   │          │
│  │    Queue   │  │   Review    │  │    Base      │          │
│  └────────────┘  └─────────────┘  └──────────────┘          │
│                                                              │
│  ┌────────────┐  ┌─────────────┐  ┌──────────────┐          │
│  │  Sprints   │  │   Routes    │  │  Activity    │          │
│  │  Planning  │  │ Dispatcher  │  │     Log      │          │
│  └────────────┘  └─────────────┘  └──────────────┘          │
│                                                              │
└──────────────┬───────────────────────────────────────────────┘
               │
               │ Delivery Routes (on approve)
               │
               ▼
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│                   External Destinations                      │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐   │
│  │WordPress │  │  Email   │  │  Slack   │  │  S3/B2    │   │
│  │          │  │  (SMTP)  │  │          │  │  Storage  │   │
│  └──────────┘  └──────────┘  └──────────┘  └───────────┘   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Component Responsibilities

### 1. OpenClaw (AI Assistant)

**Role:** Conversational interface and task executor

**Responsibilities:**
- Parse user natural language requests
- Invoke Cavendo Engine skill scripts
- Execute tasks using appropriate AI models
- Format responses for human readability
- Send notifications (Signal, Slack, etc.)
- Integrate with cron jobs for automation

**Does NOT:**
- Store task/deliverable data (Cavendo Engine handles this)
- Manage workflow state (delegated to Cavendo Engine)
- Handle content routing (Cavendo Engine delivery routes)

### 2. Cavendo Engine Skill (This Skill)

**Role:** Bridge between OpenClaw and Cavendo Engine

**Responsibilities:**
- Provide Python scripts for common operations
- Wrap Cavendo SDK with OpenClaw-specific logic
- Format API responses for display
- Manage configuration (.env, model selection)
- Implement notification helpers
- Handle error recovery and retries

**Does NOT:**
- Run as a daemon (invoked on-demand by OpenClaw)
- Maintain persistent connections (stateless)
- Make UI decisions (presents data, user chooses)

### 3. Cavendo Engine (Backend Platform)

**Role:** Workflow orchestration and data persistence

**Responsibilities:**
- Store tasks, deliverables, knowledge base, sprints
- Provide REST API for all operations
- Manage agent authentication (API keys)
- Track activity logs and metrics
- Execute delivery routes on approval
- Maintain version chains for deliverables
- Run background dispatchers (optional)

**Does NOT:**
- Know about OpenClaw (API-agnostic)
- Generate conversational responses (just returns data)
- Execute AI models directly (agents/skills do this)

---

## Data Flow: Task Execution

### Happy Path (No Revision)

```
1. User creates task
   └──> OpenClaw: "Create a Cavendo task for market research"
   └──> Skill: POST /api/tasks (title, description, priority, project)
   └──> Cavendo Engine: Creates task #42, returns ID
   └──> OpenClaw: "Created task #42"

2. Auto-worker claims task (cron or manual)
   └──> Skill: GET /api/agents/me/tasks/next
   └──> Cavendo Engine: Returns task #42
   └──> Skill: POST /api/tasks/42/claim
   └──> Cavendo Engine: Marks as "assigned", returns context

3. Skill executes task
   └──> Skill: GET /api/tasks/42/context (knowledge base, previous deliverables)
   └──> Cavendo Engine: Returns full context bundle
   └──> Skill: Calls Claude Sonnet with prompt + context
   └──> Claude: Generates deliverable content
   └──> Skill: POST /api/deliverables (task_id, title, content, metadata)
   └──> Cavendo Engine: Creates deliverable #101, sets task to "review"

4. User reviews deliverable
   └──> OpenClaw: "Show me deliverable 101"
   └──> Skill: GET /api/deliverables/101
   └──> Cavendo Engine: Returns deliverable data
   └──> OpenClaw: [Displays formatted content]
   └──> User: "Approve it"
   └──> Skill: PATCH /api/deliverables/101/review (action: approve)
   └──> Cavendo Engine: 
       • Marks deliverable as "approved"
       • Sets task to "completed"
       • Triggers delivery routes
       • Logs activity

5. Delivery routes execute
   └──> Cavendo Engine Route Dispatcher:
       • Sends email to stakeholders
       • Posts to Slack channel
       • Uploads to S3 bucket
       • Calls webhook for WordPress publish
```

### Revision Path

```
4. User requests revision
   └──> User: "Send it back for revision - need more examples"
   └──> Skill: PATCH /api/deliverables/101/review 
       (action: revise, feedback: "need more examples")
   └──> Cavendo Engine:
       • Marks deliverable #101 as "revised"
       • Sets task #42 back to "assigned"
       • Attaches feedback to task context

5. Auto-worker re-executes
   └──> Skill: GET /api/agents/me/tasks/next
   └──> Cavendo Engine: Returns task #42 with revision feedback
   └──> Skill: Calls Claude with original prompt + feedback
   └──> Claude: Generates improved version
   └──> Skill: POST /api/deliverables 
       (task_id: 42, parent_id: 101, version: 2)
   └──> Cavendo Engine: Creates deliverable #102, links to #101

6. User approves v2
   └──> Skill: PATCH /api/deliverables/102/review (action: approve)
   └──> Cavendo Engine: Marks approved, triggers routes
```

---

## Integration Points

### 1. Morning Briefing (6 AM Cron)

**Goal:** Show pending Cavendo tasks in daily briefing

**Implementation:**
```python
# In OpenClaw morning briefing cron job
result = exec("python ~/clawd/skills/cavendo-engine-1.0.0/scripts/check_tasks.py --format brief")
briefing += f"\n\n## 📋 Cavendo Tasks\n{result}"
```

**Output Example:**
```
📋 Cavendo Tasks

Found 3 task(s):

**High Priority:**
  • #42: BoardSite market intel report
  • #45: CheckMyDev competitive analysis

**Medium Priority:**
  • #47: Blog post draft: AI workflows
```

### 2. Sprint Check-In (2 PM, 6 PM Crons)

**Goal:** Include sprint progress in check-in messages

**Implementation:**
```python
# In OpenClaw sprint check-in cron job
result = exec("python ~/clawd/skills/cavendo-engine-1.0.0/scripts/sprint_summary.py")
checkin += f"\n\n## Sprint Progress\n{result}"
```

**Output Example:**
```
Sprint Progress

**Sprint: Week of Feb 17 - Feb 24**
Status: Active

**Progress:**
✅ Completed: 4/7 (57%)
🔄 In Progress: 2
⏳ Pending: 1

**Timeline:**
Start: 2026-02-17
End: 2026-02-24
```

### 3. Auto-Worker Loop (Every 5-30 Minutes)

**Goal:** Automatically claim and execute tasks

**Implementation Option A (Isolated Cron):**
```json
{
  "name": "Cavendo Auto-Worker",
  "schedule": {
    "kind": "every",
    "everyMs": 300000
  },
  "payload": {
    "kind": "agentTurn",
    "message": "Check Cavendo Engine for new tasks. If available, claim the next one, execute it, and submit the deliverable. If successful, notify me. If no tasks, respond with HEARTBEAT_OK."
  },
  "sessionTarget": "isolated",
  "delivery": {
    "mode": "announce",
    "channel": "signal"
  }
}
```

**Implementation Option B (Direct Script):**
```python
# Run as cron job (simplest approach)
python ~/clawd/skills/cavendo-engine-1.0.0/scripts/auto_worker.py
```

**Output (on success):**
```
📬 Deliverable ready for review

Task #42: BoardSite market intel report
Deliverable #101: 24-page analysis (12,453 chars)
Status: Pending Review

View: https://portal.cavendo.net/deliverables/101
```

### 4. Conversational Commands

**Natural Language → Skill Invocation Mapping:**

| User Input | Skill Script | Parameters |
|-----------|--------------|------------|
| "Check Cavendo for tasks" | `check_tasks.py` | `--format brief` |
| "What's my next Cavendo task?" | `check_tasks.py` | `--format detailed --status pending` |
| "Claim the next Cavendo task" | `claim_next.py` | (auto-executes) |
| "Show me task 42" | `show_task.py` | `42` |
| "Show me deliverable 101" | `show_deliverable.py` | `101` |
| "Approve deliverable 101" | `review_deliverable.py` | `101 --action approve` |
| "Send deliverable 101 back for revision" | `review_deliverable.py` | `101 --action revise --feedback "..."` |
| "What's in the current sprint?" | `sprint_summary.py` | (uses current sprint) |
| "Search Cavendo KB for pricing" | `search_knowledge.py` | `"pricing" --project-id 1` |

**OpenClaw Implementation:**
```python
# In OpenClaw skill handler
if user_message.contains("check cavendo"):
    result = exec_skill("cavendo-engine", "check_tasks.py")
    respond(format_for_chat(result))

elif user_message.contains("approve deliverable"):
    deliverable_id = extract_id(user_message)
    result = exec_skill("cavendo-engine", f"review_deliverable.py {deliverable_id} --action approve")
    respond(result)
    # Possibly trigger notification
```

---

## Authentication & Security

### API Key Types

**User Keys (`cav_uk_...`):**
- Acts as the human user
- Full permissions to create/view/approve
- Recommended for personal OpenClaw instances
- One key per user

**Agent Keys (`cav_ak_...`):**
- Acts as AI agent identity
- Can be scoped to specific projects/permissions
- Recommended for shared/production deployments
- Multiple keys per agent (rotation)

### Configuration Security

**Environment Variables (.env):**
```env
CAVENDO_AGENT_KEY=cav_uk_xxxxx  # Never commit to git
```

**Best Practices:**
- Store `.env` locally (add to `.gitignore`)
- Use `.env.example` for templates (no real keys)
- Rotate keys periodically
- Use agent keys for automation (user keys for manual)
- Review activity logs for suspicious behavior

### Network Security

**Local Deployment:**
- Cavendo Engine runs on localhost (no external exposure)
- API accessible only from local machine
- No TLS required (localhost trusted)

**Cloud Deployment:**
- HTTPS required (TLS 1.2+)
- API key sent in `X-Agent-Key` header (encrypted in transit)
- Consider IP whitelist for additional security
- Use firewall rules to restrict access

---

## Model Selection Strategy

### Priority-Based Routing

**High Priority (1):**
- Model: Claude Sonnet 3.5
- Use Case: Important deliverables, client-facing content
- Cost: ~$3/million input tokens, $15/million output
- Speed: Moderate (8-15 seconds)

**Medium Priority (2):**
- Model: Claude Haiku 3.5
- Use Case: Internal docs, drafts, routine tasks
- Cost: ~$0.25/million input, $1.25/million output
- Speed: Fast (3-8 seconds)

**Low Priority (3-4):**
- Model: Claude Haiku 3.5
- Use Case: Summaries, simple rewrites
- Cost: ~$0.25/million input, $1.25/million output
- Speed: Fast (3-8 seconds)

**Research Tasks:**
- Model: OpenAI o1 (optional)
- Use Case: Complex analysis, multi-step reasoning
- Cost: Higher (~$15/million input, $60/million output)
- Speed: Slower (20-60 seconds)

**Configuration:**
```env
CAVENDO_MODEL_HIGH=anthropic/claude-sonnet-3.5
CAVENDO_MODEL_MEDIUM=anthropic/claude-haiku-3.5
CAVENDO_MODEL_LOW=anthropic/claude-haiku-3.5
CAVENDO_MODEL_RESEARCH=openai/o1
```

### Dynamic Selection

```python
# In lib/task_executor.py
def get_model_for_task(task):
    if task.priority == 1:
        return os.getenv("CAVENDO_MODEL_HIGH")
    elif "research" in task.title.lower():
        return os.getenv("CAVENDO_MODEL_RESEARCH")
    else:
        return get_model_for_priority(task.priority)
```

---

## Error Handling

### Retryable vs Non-Retryable Errors

**Retryable (auto-retry after cooldown):**
- 429 Rate Limit Exceeded
- 503 Service Unavailable  
- 529 Overloaded
- Network timeouts
- Temporary auth failures

**Non-Retryable (flag and skip):**
- 400 Bad Request (malformed task)
- 401 Unauthorized (invalid API key)
- 404 Not Found (deleted task)
- AI safety blocks (content policy violation)
- Validation errors (missing required fields)

### Error Recovery Flow

```
1. Task execution fails with 429 Rate Limit
   └──> Cavendo Engine: Records error in task.context.lastExecutionError
   └──> Set retryable: true, nextRetryAt: now + 5 minutes

2. Auto-worker checks again in 5 minutes
   └──> Dispatcher: Finds task with nextRetryAt <= now
   └──> Retries execution

3. Task succeeds on retry
   └──> Clears error context
   └──> Submits deliverable
```

### Logging

**Skill-Level Logging:**
```python
import logging

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(message)s"
)

logger.info("Claimed task #42")
logger.warning("Task #42 needs retry (rate limit)")
logger.error("Failed to connect to Cavendo Engine")
```

**Cavendo Engine Activity Log:**
- All API calls logged automatically
- Full audit trail (who, what, when)
- Queryable via `/api/activity` endpoints

---

## Performance Considerations

### Rate Limiting

**Cavendo Engine API:**
- Default: 100 requests/minute per API key
- Can be adjusted in `server/.env`
- Returns 429 if exceeded

**AI Provider APIs:**
- Anthropic: Tier-based (depends on spend)
- OpenAI: Tier-based (depends on spend)
- Handle 429s with exponential backoff

### Batch Operations

**Bulk Task Creation:**
```python
# Instead of 10 individual POSTs
for task in tasks:
    client.tasks.create(task)  # ❌ 10 API calls

# Use bulk endpoint
client.tasks.bulk_create(tasks)  # ✅ 1 API call (up to 50 tasks)
```

### Caching

**Knowledge Base:**
- Cache frequently-accessed KB entries in memory
- Invalidate on update events (webhook)

**Task Context:**
- Context bundles are large (KB + deliverables + feedback)
- Cache per-task for duration of execution
- Clear after deliverable submission

### Concurrent Execution

**Max Concurrent Tasks:**
```env
CAVENDO_MAX_CONCURRENT=3  # Don't overload AI APIs
```

**Implementation:**
```python
# In auto_worker.py
active_count = client.tasks.count(status="in_progress")
if active_count >= get_max_concurrent():
    print("Max concurrent tasks reached, skipping claim")
    return
```

---

## Deployment Scenarios

### Scenario 1: Personal Use (Single User)

**Setup:**
- Cavendo Engine on localhost:3001
- OpenClaw on same machine
- User API key (`cav_uk_...`)
- Auto-worker cron enabled

**Pros:**
- Simple setup
- Full control
- No network exposure
- Fast (local API)

**Cons:**
- Single machine dependency
- No remote access
- Manual backups

### Scenario 2: Team Use (Multi-User)

**Setup:**
- Cavendo Engine on VPS/cloud (https://portal.cavendo.net)
- Multiple OpenClaw instances (each team member)
- Agent keys per instance (`cav_ak_...`)
- Shared projects, separate tasks

**Pros:**
- Team collaboration
- Remote access
- Centralized data
- Role-based permissions

**Cons:**
- More complex setup
- Network latency
- TLS required
- Backup strategy needed

### Scenario 3: Production (Client Work)

**Setup:**
- Cavendo Engine on dedicated server
- Multiple agents (OpenClaw + external bots)
- Delivery routes to client systems
- Webhooks for integrations
- Monitoring and alerting

**Pros:**
- Scalable
- Professional integrations
- Audit trail for clients
- SLA compliance

**Cons:**
- Infrastructure costs
- DevOps overhead
- Security hardening required

---

## Testing Strategy

### Unit Tests

**Skill Scripts:**
```bash
pytest tests/test_check_tasks.py
pytest tests/test_claim_next.py
pytest tests/test_formatters.py
```

**Mocking:**
- Mock Cavendo API responses
- Test error handling paths
- Validate formatters independently

### Integration Tests

**Against Live Cavendo Instance:**
```bash
# Start local Cavendo Engine
cd ~/cavendo-engine && npm start

# Run integration tests
pytest tests/integration/ --cavendo-url http://localhost:3001
```

**Test Cases:**
- Create task → Claim → Execute → Submit → Approve
- Create task → Claim → Execute → Submit → Revise → Re-execute → Approve
- Sprint creation → Add tasks → Track progress
- Knowledge base search → Use in task context

### End-to-End Tests

**Full Workflow Simulation:**
1. User creates task via OpenClaw
2. Auto-worker claims and executes
3. User reviews deliverable
4. User requests revision
5. Auto-worker re-executes
6. User approves
7. Delivery routes trigger
8. Verify content at destinations

---

## Monitoring & Observability

### Metrics to Track

**Task Metrics:**
- Tasks created per day/week
- Tasks completed per day/week
- Average time from creation to completion
- Average time from assignment to submission
- Tasks by status (pending, in_progress, review, completed)

**Deliverable Metrics:**
- Deliverables submitted per day/week
- Approval rate (% approved on first submission)
- Revision rate (% needing revision)
- Rejection rate (% rejected)
- Average review time (submission to approval)

**Quality Metrics:**
- Deliverable length (chars/words)
- Token usage (input/output)
- Model used (by priority/task type)
- Execution time per task

**Sprint Metrics:**
- Sprint velocity (tasks completed per sprint)
- Sprint completion rate (planned vs actual)
- Sprint duration (actual vs estimated)

### Dashboards

**Cavendo Engine UI:**
- Built-in metrics dashboard
- Activity log viewer
- Agent performance cards

**External (Optional):**
- Grafana + Prometheus
- Custom reporting scripts
- Export to Google Sheets

### Alerts

**Critical:**
- API authentication failures (invalid key)
- Delivery route failures (email not sent)
- High error rate (>10% tasks failing)

**Warning:**
- Rate limit approaching
- Low approval rate (<80%)
- High revision rate (>30%)
- Slow execution time (>60s average)

---

## Future Enhancements

### v1.1
- Task templates (create similar tasks in bulk)
- Automated quality scoring (pre-submission checks)
- Multi-agent coordination (tasks requiring multiple agents)
- Conditional routing (approve → publish, reject → archive)

### v1.2
- Interactive deliverable editing (inline change requests)
- Knowledge base auto-updates (approved content → KB)
- Advanced analytics (sentiment analysis on feedback)
- Predictive duration estimates (based on history)

### v2.0
- Visual workflow builder (drag-and-drop task pipelines)
- A/B testing for deliverables (generate variants)
- Real-time collaboration (multiple users reviewing together)
- Mobile app for review on-the-go

---

## Conclusion

This integration design provides a comprehensive blueprint for connecting OpenClaw with Cavendo Engine. The architecture is:

- **Modular:** Each component has clear responsibilities
- **Scalable:** Works from single-user to team deployments
- **Secure:** API keys, TLS, activity logging
- **Flexible:** Supports multiple AI models and routing destinations
- **Observable:** Rich metrics and audit trails

**Implementation Status:**
- ✅ Core skill structure complete
- ✅ Python SDK integration
- ✅ Basic scripts (connection, check, claim)
- ⏳ Advanced scripts (auto-worker, sprint, KB)
- ⏳ OpenClaw cron integration examples
- ⏳ Production deployment guide

**Next Steps:**
1. Complete remaining scripts (auto_worker.py, sprint_summary.py, etc.)
2. Add comprehensive error handling
3. Write integration tests
4. Create video tutorial
5. Deploy to production (Jonathan's setup)
6. Gather feedback and iterate

---

**Document Version:** 1.0.0  
**Last Updated:** February 17, 2026  
**Maintained By:** Cavendo Team
