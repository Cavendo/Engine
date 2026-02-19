# @cavendo/mcp-server

MCP (Model Context Protocol) server for Cavendo Engine - an AI agent workflow platform.

This server allows AI agents (like Claude) to interact with Cavendo Engine to receive tasks, submit deliverables, access knowledge bases, and manage their workflow.

## Installation

### Global Installation

```bash
npm install -g @cavendo/mcp-server
```

### Local Installation

```bash
npm install @cavendo/mcp-server
```

## Configuration

The server requires the following environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CAVENDO_AGENT_KEY` | Yes | - | Your agent API key from Cavendo Engine |
| `CAVENDO_URL` | No | `http://localhost:3001` | Base URL of the Cavendo Engine API |

### Getting Your API Key

Before configuring the MCP server, you need an API key from your Cavendo Engine instance:

**Option A: Personal User Key** (recommended for human users)

1. Log in to your Cavendo Engine UI (e.g., `http://localhost:5173`)
2. Go to **Settings** (gear icon in the sidebar)
3. Under **API Keys**, click **Generate Key**
4. Copy the key (format: `cav_uk_...`) — it won't be shown again

**Option B: Agent Key** (for automated bots)

1. Log in as an admin
2. Go to **Agents** and create or select an agent
3. Under the agent's **API Keys** section, click **Generate Key**
4. Copy the key (format: `cav_ak_...`)

User keys (`cav_uk_`) act as you and show your tasks. Agent keys (`cav_ak_`) act as the bot identity.

### Claude Desktop Configuration

Add the following to your Claude Desktop MCP configuration file (`mcp_config.json`):

```json
{
  "mcpServers": {
    "cavendo": {
      "command": "cavendo-mcp",
      "env": {
        "CAVENDO_AGENT_KEY": "your-agent-api-key-here",
        "CAVENDO_URL": "https://your-cavendo-instance.com"
      }
    }
  }
}
```

If installed locally with npx:

```json
{
  "mcpServers": {
    "cavendo": {
      "command": "npx",
      "args": ["@cavendo/mcp-server"],
      "env": {
        "CAVENDO_AGENT_KEY": "your-agent-api-key-here",
        "CAVENDO_URL": "https://your-cavendo-instance.com"
      }
    }
  }
}
```

## Tools

The server provides 12 tools for interacting with Cavendo Engine:

### Task Management

#### `cavendo_list_tasks`
List tasks assigned to this agent with optional filtering.

**Parameters:**
- `status` (optional): Filter by task status (`pending`, `assigned`, `in_progress`, `review`, `completed`, `cancelled`)
- `projectId` (optional): Filter by project ID
- `limit` (optional): Maximum number of tasks to return (default: 50)

#### `cavendo_get_next_task`
Get the highest-priority unstarted task from the queue. This is the recommended way to get work - it automatically selects the most important task that is ready to be worked on.

**Parameters:** None

#### `cavendo_get_task_context`
Get the full context bundle for a task, including task details, project information, relevant knowledge documents, related tasks, existing deliverables, and task history.

**Parameters:**
- `taskId` (required): The ID of the task to get context for

#### `cavendo_update_task_status`
Update the status of a task to indicate progress.

**Parameters:**
- `taskId` (required): The ID of the task to update
- `status` (required): New status (`in_progress`, `review`)
- `message` (optional): Message explaining the status change

#### `cavendo_log_progress`
Log a progress update for a task to provide visibility into ongoing work.

**Parameters:**
- `taskId` (required): The ID of the task
- `message` (required): Description of the progress made
- `percentComplete` (optional): Percentage completion (0-100)

#### `cavendo_claim_task`
Claim an unassigned task from the pool. Use this to self-assign a task that is not already assigned to another agent.

**Parameters:**
- `taskId` (required): The ID of the task to claim

#### `cavendo_create_task`
Create a new task or subtask. Use this to break down larger tasks or create follow-up tasks.

**Parameters:**
- `title` (required): Title of the task
- `projectId` (required): Numeric project ID to create the task in
- `description` (optional): Detailed description of the task
- `priority` (optional): Priority level 1-4 (1=highest, default: 3)
- `assignedAgentId` (optional): Numeric agent ID to assign the task to. Omit to leave unassigned or let routing rules decide.

#### `cavendo_list_agents`
List available agents. Use this to discover agent IDs for task assignment.

**Parameters:**
- `capability` (optional): Filter by capability (e.g., `research`, `content_generation`)
- `status` (optional): Filter by agent status (`active`, `paused`, `disabled`)
- `available` (optional): If `true`, only return agents with spare capacity for new tasks

### Deliverable Management

#### `cavendo_submit_deliverable`
Submit a deliverable (work product) for a task or as a standalone deliverable.

**Parameters:**
- `taskId` (optional): The ID of the task this deliverable is for - omit for standalone
- `projectId` (optional): Project ID or name for standalone deliverables
- `title` (required): Descriptive title for the deliverable
- `summary` (optional): Text description of the work (shown in Overview tab)
- `content` (optional): Plain text/markdown content - DO NOT use for HTML/code
- `files` (optional): Array of file attachments for code deliverables (HTML, JSX, CSS, JS)
- `actions` (optional): Follow-up action items for the reviewer
- `metadata` (optional): Additional metadata (e.g., sources, references)

#### `cavendo_get_revision_feedback`
Get feedback for a deliverable that needs revision.

**Parameters:**
- `deliverableId` (required): The ID of the deliverable

#### `cavendo_submit_revision`
Submit a revised version of a deliverable.

**Parameters:**
- `deliverableId` (required): The ID of the deliverable to revise
- `summary` (optional): Text description of the revision changes
- `content` (optional): The revised content (for text/markdown)
- `files` (optional): Array of file attachments for code revisions
- `title` (optional): New title for the revision
- `contentType` (optional): New content type (`markdown`, `html`, `json`, `text`, `code`)
- `metadata` (optional): Additional metadata for the revision

### Knowledge Base

#### `cavendo_search_knowledge`
Search the Cavendo knowledge base for relevant documentation, guidelines, references, or examples.

**Parameters:**
- `query` (required): Search query
- `projectId` (optional): Limit search to a specific project
- `type` (optional): Filter by document type (`documentation`, `guideline`, `reference`, `template`, `example`)
- `limit` (optional): Maximum results (default: 10)

## Resources

The server exposes 3 resources for browsing Cavendo data:

### Static Resources

#### `cavendo://projects`
List all projects the agent has access to in Cavendo Engine.

#### `cavendo://tasks/assigned`
All tasks currently assigned to this agent, grouped by status.

### Resource Templates

#### `cavendo://projects/{id}/knowledge`
Knowledge documents for a specific project. Replace `{id}` with the project ID.

## Example Usage

Here's a typical workflow for an AI agent using this server:

```
1. Check for available work:
   Use cavendo_get_next_task to get the highest-priority task

2. Get full context:
   Use cavendo_get_task_context with the task ID to understand requirements

3. Start working:
   Use cavendo_update_task_status to set status to "in_progress"

4. Log progress (for long tasks):
   Use cavendo_log_progress to show incremental progress

5. Search for information:
   Use cavendo_search_knowledge to find relevant documentation

6. Submit deliverables:
   Use cavendo_submit_deliverable for each work product

7. Request review:
   Use cavendo_update_task_status to set status to "review"

8. Handle revisions (if needed):
   Use cavendo_get_revision_feedback to understand required changes
   Use cavendo_submit_revision to submit the updated deliverable
```

## Error Handling

The server provides clear error messages for common issues:

- **Configuration errors**: Missing `CAVENDO_AGENT_KEY` will show instructions for setting it
- **API errors**: Network issues or API errors include status codes and messages
- **Not found errors**: Clear messages when tasks, deliverables, or projects don't exist
- **Permission errors**: Messages when the agent doesn't have access to a resource

## Development

### Building

```bash
npm run build
```

### Development Mode

```bash
npm run dev
```

This watches for changes and recompiles automatically.

### Testing

Run the server manually to test:

```bash
CAVENDO_AGENT_KEY=your-key CAVENDO_URL=http://localhost:3001 node bin/cavendo-mcp.js
```

## API Endpoints

This server communicates with the following Cavendo Engine API endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/agents/me` | GET | Get current agent info |
| `/api/agents/me/tasks` | GET | List assigned tasks |
| `/api/agents/me/tasks/next` | GET | Get next task from queue |
| `/api/tasks` | POST | Create new task |
| `/api/tasks/:id/context` | GET | Get task context bundle |
| `/api/tasks/:id/status` | PATCH | Update task status |
| `/api/tasks/:id/progress` | POST | Log progress update |
| `/api/tasks/:id/claim` | POST | Claim task |
| `/api/deliverables` | POST | Submit deliverable |
| `/api/deliverables/:id/feedback` | GET | Get revision feedback |
| `/api/deliverables/:id/revision` | POST | Submit revision |
| `/api/knowledge/search` | GET | Search knowledge base |
| `/api/projects` | GET | List projects |
| `/api/projects/:id` | GET | Get project details |
| `/api/projects/:id/knowledge` | GET | Get project knowledge |

All endpoints require the `X-Agent-Key` header for authentication.

## License

AGPL-3.0 — See [LICENSE](../../LICENSE) for details.

For alternative licensing arrangements, contact [sales@cavendo.com](mailto:sales@cavendo.com).
