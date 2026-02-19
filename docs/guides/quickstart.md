# Quick Start Guide

Get Cavendo Engine running in 5 minutes.

## Prerequisites

- **Node.js** 18.0 or higher
- **npm** or **yarn**
- **Python** 3.x with setuptools (for native module compilation)
  - macOS: `brew install python-setuptools`
  - Linux: `pip install setuptools` or install via package manager
  - Windows: Usually included with Python installer

## Installation

### Option 1: Clone the Repository

```bash
git clone https://github.com/Cavendo/Engine.git Cavendo-Engine
cd Cavendo-Engine

# Install server dependencies
npm install

# Install UI dependencies
cd ui && npm install && cd ..

# Initialize the database
node server/db/init.js

# Start the development server
npm run dev
```

## Access the Admin UI

Open [http://localhost:5173](http://localhost:5173) (development) or [http://localhost:3001](http://localhost:3001) (production).

**Default credentials:**
- Email: `admin@cavendo.local`
- Password: `admin`

> **Important:** Change the default password immediately in production.

## Getting Started

On first run, Cavendo Engine creates a default "My First Project" and shows a Getting Started checklist on the Review page to guide you through setup.

## Your First Agent Workflow

### Step 1: Register an Agent

1. Navigate to **Agents** in the sidebar
2. Click **Register Agent**
3. Enter:
   - Name: `My First Agent`
   - Type: `Supervised`
   - Description: `Test agent for demonstration`
4. Click **Register**

**Optional — Enable auto-execution:**
To have the Task Dispatcher automatically execute tasks for this agent:
1. Click **Manage** on the agent
2. Go to **Task Execution**
3. Select a provider (Anthropic or OpenAI) and enter your API key
4. Set **Execution Mode** to `Auto`

### Step 2: Generate an API Key

1. Find your agent in the list
2. Click **Generate Key**
3. **Copy and save the key** - it won't be shown again!

### Step 3: Create a Project

A default project ("My First Project") is created on first run. You can use it or create a new one:

1. Navigate to **Projects**
2. Click **Create Project**
3. Enter a name like `Demo Project`

### Step 4: Create a Task

1. Navigate to **Tasks**
2. Click **Create Task**
3. Enter:
   - Title: `Write a summary of our project`
   - Description: `Create a brief overview of what this project does`
   - Project: Select your demo project
   - Assign to Agent: Select your agent
4. Click **Create**

### Step 5: Agent Polls for Tasks (API)

Your agent can now poll for tasks:

```bash
curl -H "X-Agent-Key: YOUR_API_KEY" \
  http://localhost:3001/api/agents/me/tasks/next
```

### Step 6: Agent Gets Context

```bash
curl -H "X-Agent-Key: YOUR_API_KEY" \
  http://localhost:3001/api/tasks/1/context
```

### Step 7: Agent Submits a Deliverable

```bash
curl -X POST http://localhost:3001/api/deliverables \
  -H "X-Agent-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": 1,
    "title": "Project Summary",
    "content": "## Overview\n\nThis project demonstrates the Cavendo Engine workflow...",
    "contentType": "markdown"
  }'
```

### Step 8: Review the Deliverable

1. Navigate to **Review** in the Admin UI
2. You'll see the pending deliverable
3. Click **View** to see the content
4. Click **Approve**, **Request Revision**, or **Reject**

## What's Next?

- **[Set up task routing](./task-routing.md)** — Configure agents with AI providers, set up routing rules, and enable auto-execution so tasks are assigned and completed automatically. **This is the recommended next step.**
- [Configure webhooks](./webhooks.md) to get real-time notifications
- [Set up the MCP server](../integrations/mcp.md) for Claude Desktop integration
- [Install the Python SDK](../integrations/python-sdk.md) for your agent framework
- [Add knowledge](./knowledge.md) to give agents project context

> **Note:** Without routing rules or a default agent on your project, tasks will stay in `pending` status until manually assigned. See the [Task Routing guide](./task-routing.md) for setup instructions.

## Example Agent Implementations

### Python Agent (using SDK)

```python
from cavendo import CavendoClient

client = CavendoClient(
    url="http://localhost:3001",
    api_key="cav_ak_..."
)

# Get next task
task = client.tasks.next()

if task:
    # Get full context
    context = client.tasks.context(task.id)

    # Update status
    client.tasks.update_status(task.id, 'in_progress')

    # Do the work...
    result = do_ai_work(context)

    # Submit deliverable
    client.deliverables.submit(
        task_id=task.id,
        title="Completed Task",
        content=result
    )
```

### Claude Desktop (MCP)

Once configured, Claude can naturally interact:

```
User: What tasks are assigned to me?

Claude: [Uses cavendo_list_tasks] You have 3 tasks assigned:
1. Write project summary (High priority)
2. Review API documentation (Medium priority)
3. Create integration tests (Low priority)

User: Work on the first one.

Claude: [Uses cavendo_get_task_context] I'll review the task context...
[Uses cavendo_update_task_status] Marking as in progress...
[Does the work]
[Uses cavendo_submit_deliverable] Submitting the deliverable...

Done! I've submitted a project summary for review.
```
