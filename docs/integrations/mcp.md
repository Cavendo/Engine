# MCP Server Integration

The Cavendo MCP Server enables Claude Desktop and other MCP-compatible clients to interact with Cavendo Engine naturally.

## Installation

```bash
npm install -g @cavendo/mcp-server
```

Or use with npx:

```bash
npx @cavendo/mcp-server
```

## Configuration

### Claude Desktop

Add to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

**Using a User Key (acts as you):**

```json
{
  "mcpServers": {
    "cavendo": {
      "command": "npx",
      "args": ["@cavendo/mcp-server"],
      "env": {
        "CAVENDO_AGENT_KEY": "cav_uk_your_user_key_here"
      }
    }
  }
}
```

**Using an Agent Key (bot identity):**

```json
{
  "mcpServers": {
    "cavendo": {
      "command": "npx",
      "args": ["@cavendo/mcp-server"],
      "env": {
        "CAVENDO_URL": "https://your-cavendo-instance.com",
        "CAVENDO_AGENT_KEY": "cav_ak_your_agent_key_here"
      }
    }
  }
}
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CAVENDO_AGENT_KEY` | Yes | - | User key (`cav_uk_...`) or Agent key (`cav_ak_...`) |
| `CAVENDO_URL` | No | `http://localhost:3001` | Cavendo Engine server URL |

### Key Types

| Key Type | Format | Behavior |
|----------|--------|----------|
| User Key | `cav_uk_...` | "My tasks" returns tasks for your linked agent, deliverables show your name |
| Agent Key | `cav_ak_...` | "My tasks" returns agent's tasks only, deliverables show agent name |

## Available Tools

### `cavendo_list_tasks`

List tasks assigned to this agent.

**Parameters:**
- `status` (optional): Filter by status (pending, assigned, in_progress, review, completed, cancelled)

**Example:**
```
Claude: What tasks are assigned to me?
[Uses cavendo_list_tasks]
You have 3 tasks assigned:
1. Write API documentation (High priority)
2. Review competitor pricing (Medium priority)
3. Create onboarding guide (Low priority)
```

### `cavendo_get_next_task`

Get the highest-priority pending task.

**Example:**
```
Claude: What should I work on next?
[Uses cavendo_get_next_task]
Your next task is "Write API documentation" (High priority).
Description: Create comprehensive REST API documentation with examples.
```

### `cavendo_get_task_context`

Get full context for a task including project knowledge and previous deliverables.

**Parameters:**
- `taskId` (required): Task ID

**Example:**
```
Claude: Give me context for task 5.
[Uses cavendo_get_task_context]
Task: Write API documentation
Project: Cavendo Engine
Related Knowledge:
- API Design Guidelines
- REST Best Practices
Previous Deliverables:
- Draft v1 (revision requested): "Please add more examples"
```

### `cavendo_update_task_status`

Update the status of a task.

**Parameters:**
- `taskId` (required): Task ID
- `status` (required): New status (in_progress, review)
- `message` (optional): Message explaining the status change

**Example:**
```
Claude: I'm starting work on task 5.
[Uses cavendo_update_task_status with status="in_progress"]
Task 5 marked as in progress.
```

### `cavendo_submit_deliverable`

Submit completed work for review.

**Parameters:**
- `taskId` (optional): Task ID - omit for standalone deliverables
- `projectId` (optional): Project ID or name - use for standalone deliverables
- `title` (required): Deliverable title
- `summary` (optional): Text description of the work (shown in Overview tab)
- `content` (optional): Plain text/markdown content - DO NOT use for HTML/code
- `files` (optional): Array of file attachments for code deliverables
- `actions` (optional): Follow-up action items for the reviewer
- `inputTokens` (optional): Input tokens used (for cost tracking)
- `outputTokens` (optional): Output tokens used (for cost tracking)
- `provider` (optional): AI provider name (e.g., "anthropic", "openai")
- `model` (optional): Model used (e.g., "claude-opus-4", "gpt-4o")

**Example:**
```
Claude: I've completed the documentation. Submit it for review.
[Uses cavendo_submit_deliverable]
Deliverable "API Documentation v1" submitted for review.
The task is now in review status.
```

### `cavendo_get_revision_feedback`

Get feedback for a deliverable that needs revision.

**Parameters:**
- `deliverableId` (required): Deliverable ID

**Example:**
```
Claude: What feedback did I receive on deliverable 3?
[Uses cavendo_get_revision_feedback]
Feedback: "Please add authentication examples and error response documentation."
```

### `cavendo_submit_revision`

Submit a revised version of a deliverable.

**Parameters:**
- `deliverableId` (required): Original deliverable ID
- `summary` (optional): Text description of revision changes
- `content` (optional): Revised content (for text/markdown)
- `files` (optional): Array of file attachments (for code revisions)
- `title` (optional): New title
- `contentType` (optional): New content type

### `cavendo_search_knowledge`

Search the project knowledge base.

**Parameters:**
- `query` (required): Search query
- `projectId` (optional): Limit to specific project
- `type` (optional): Filter by type (documentation, guideline, reference, template, example)
- `limit` (optional): Maximum results to return (default: 10)

**Example:**
```
Claude: Search for API authentication guidelines.
[Uses cavendo_search_knowledge with query="API authentication"]
Found 2 results:
1. Authentication Best Practices (guidelines)
2. OAuth Implementation Guide (reference)
```

### `cavendo_log_progress`

Log a progress update on a task.

**Parameters:**
- `taskId` (required): Task ID
- `message` (required): Progress message
- `percentComplete` (optional): Progress percentage (0-100)

**Example:**
```
Claude: I'm 50% done with task 5.
[Uses cavendo_log_progress with percentComplete=50]
Progress logged: "50% complete" on task 5.
```

### `cavendo_claim_task`

Claim an unassigned task from the pool.

**Parameters:**
- `taskId` (required): Task ID to claim

**Example:**
```
Claude: I'd like to work on task 10.
[Uses cavendo_claim_task]
Task 10 "Fix authentication bug" has been assigned to you.
```

### `cavendo_create_task`

Create a new task.

**Parameters:**
- `title` (required): Task title
- `projectId` (required): Project ID
- `description` (optional): Task description
- `priority` (optional): Priority 1-4 (1=highest, 4=lowest, default: 3)
- `assignedAgentId` (optional): Agent ID to assign the task to. Omit to leave unassigned or let routing rules decide.

**Example:**
```
Claude: Create a follow-up task for documentation updates and assign it to agent 2.
[Uses cavendo_create_task with assignedAgentId="2"]
Created task "Update API documentation" in project 1, assigned to Content Writer.
```

### `cavendo_list_agents`

List available agents. Use this to discover agent IDs for task assignment.

**Parameters:**
- `capability` (optional): Filter by capability (e.g., "research", "content_generation")
- `status` (optional): Filter by status (active, paused, disabled)
- `available` (optional): If true, only return agents with spare capacity

**Example:**
```
Claude: Which agents are available to take on new work?
[Uses cavendo_list_agents with available=true]
Found 2 agents with spare capacity:
1. Research Agent (ID: 1) - Capabilities: research, analysis
2. Content Writer (ID: 2) - Capabilities: writing, editing
```

## Available Resources

### `cavendo://projects`

List all projects the agent has access to.

### `cavendo://projects/{id}/knowledge`

Get all knowledge documents for a specific project.

### `cavendo://tasks/assigned`

Get all tasks currently assigned to this agent.

## Usage Examples

### Natural Workflow

```
User: Let's work on my assigned tasks.

Claude: [Uses cavendo_list_tasks]
You have 2 tasks assigned:
1. "Write user guide" (High priority, assigned)
2. "Review error messages" (Medium priority, in progress)

Would you like me to start on the user guide or continue with error messages?

User: Start the user guide.

Claude: [Uses cavendo_get_task_context for task 1]
[Uses cavendo_update_task_status to mark in_progress]

I've started working on the user guide. Here's what I know:
- Project: Documentation Site
- Related knowledge: Style Guide, Terminology
- Due: Tomorrow

Let me draft the initial content...

[Claude works on the content]

Here's the user guide draft. Should I submit it for review?

User: Yes, submit it.

Claude: [Uses cavendo_submit_deliverable]
Done! I've submitted "User Guide v1" for review. You'll be notified when it's approved or if revisions are needed.
```

### Handling Revisions

```
User: Check if I have any revision requests.

Claude: [Uses cavendo_list_tasks with status filter]
[Uses cavendo_get_revision_feedback]

Yes, your "API Examples" deliverable needs revision:
Feedback: "Please add error handling examples and rate limiting documentation."

Would you like me to address this feedback now?

User: Yes, update it.

Claude: [Uses cavendo_get_task_context for full context]
[Creates revised content]
[Uses cavendo_submit_revision]

Done! I've submitted the revised version with:
- Added error handling examples
- Added rate limiting documentation

The deliverable is back in review.
```

## Best Practices

1. **Always get context first** - Use `cavendo_get_task_context` before starting work
2. **Update status when starting** - Mark tasks as `in_progress` immediately
3. **Check for revisions** - Regularly check for feedback on submitted work
4. **Use the knowledge base** - Search for relevant documentation before starting
5. **Log progress** - Use `cavendo_log_progress` for long tasks
