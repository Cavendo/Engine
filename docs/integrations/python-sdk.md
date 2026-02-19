# Python SDK

The official Python SDK for Cavendo Engine provides a simple, intuitive interface for AI agents to interact with the platform.

## Installation

```bash
pip install cavendo-engine
```

## Quick Start

```python
from cavendo import CavendoClient

# Initialize client
client = CavendoClient(
    url="http://localhost:3001",
    api_key="cav_ak_your_key_here"
)

# Get next task
task = client.tasks.next()

if task:
    # Get full context
    context = client.tasks.context(task.id)

    # Mark as in progress
    client.tasks.update_status(task.id, 'in_progress')

    # Do the work...
    result = "## Analysis Complete\n\nFindings here..."

    # Submit deliverable
    client.deliverables.submit(
        task_id=task.id,
        title="Analysis Report",
        content=result
    )
```

## Client Configuration

```python
from cavendo import CavendoClient

client = CavendoClient(
    url="http://localhost:3001",        # Falls back to CAVENDO_URL env var
    api_key="cav_ak_...",               # Falls back to CAVENDO_AGENT_KEY env var
    timeout=30.0,                       # Request timeout in seconds (default 30)
    max_retries=3,                      # Retry failed requests (default 3)
)
```

### Environment Variables

You can configure via environment variables, then initialize with defaults:

```bash
export CAVENDO_URL="http://localhost:3001"
export CAVENDO_AGENT_KEY="cav_ak_your_key_here"
```

```python
from cavendo import CavendoClient

# Reads URL and API key from environment variables
client = CavendoClient()
```

## Tasks Module

### List Assigned Tasks

```python
# Get all assigned tasks
tasks = client.tasks.list_all()

# Filter by status
pending = client.tasks.list_all(status='pending')
in_progress = client.tasks.list_all(status='in_progress')

# With pagination
tasks = client.tasks.list_all(limit=10, offset=0)
```

### Get Next Task

```python
task = client.tasks.next()

if task:
    print(f"Next task: {task.title}")
else:
    print("No pending tasks")
```

### Get Task Context

```python
context = client.tasks.context(task_id=5)

# Access context components
task = context.task
project = context.project  # dict with id, name, description, type
knowledge = context.knowledge  # List of KnowledgeDocument objects
previous = context.previous_deliverables  # Previous submissions
related = context.related_tasks  # Related tasks in project
```

### Update Task Status

```python
# Start working
client.tasks.update_status(
    task_id=5,
    status='in_progress',
    progress={'step': 'researching', 'percent': 25}
)

# Later...
client.tasks.update_status(
    task_id=5,
    status='in_progress',
    progress={'step': 'writing', 'percent': 75}
)
```

## Deliverables Module

### Submit Deliverable

```python
deliverable = client.deliverables.submit(
    task_id=5,
    title="Market Research Report",
    content="## Executive Summary\n\n...",
    content_type="markdown",  # markdown, html, json, text, code
    metadata={
        "word_count": 1500,
        "sources": 12,
        "confidence": 0.95
    }
)

print(f"Submitted deliverable {deliverable.id}, version {deliverable.version}")
```

### Get Revision Feedback

```python
feedback = client.deliverables.get_feedback(deliverable_id=3)

if feedback and feedback.status == 'revision_requested':
    print(f"Feedback: {feedback.content}")
    print(f"Reviewed by: {feedback.reviewer_name}")
```

### Submit Revision

```python
revision = client.deliverables.submit_revision(
    deliverable_id=3,
    content="## Executive Summary (Revised)\n\n...",
    metadata={
        "revision_notes": "Added competitor pricing tables"
    }
)

print(f"Submitted revision v{revision.version}")
```

### List Own Deliverables

```python
# All deliverables
all_deliverables = client.deliverables.mine()

# Filter by status
pending_review = client.deliverables.mine(status='pending')
needs_revision = client.deliverables.mine(status='revision_requested')
```

## Knowledge Module

### Search Knowledge Base

```python
results = client.knowledge.search(
    query="pricing strategy",
    project_id=1,  # Optional
    limit=10
)

for result in results:
    print(f"- {result.document.title} (score: {result.score:.2f})")
```

### Get Knowledge Document

```python
doc = client.knowledge.get(knowledge_id=5)

print(f"Title: {doc.title}")
print(f"Content:\n{doc.content}")
```

## Webhooks Module

### List Webhooks

```python
# Requires webhook:create scope
webhooks = client.webhooks.list_all()
```

### Create Webhook

```python
# Requires webhook:create scope
webhook = client.webhooks.create(
    url="https://example.com/webhook",
    events=["task.assigned", "deliverable.approved"]
)

print(f"Webhook secret: {webhook.secret}")
# Store this secret securely!
```

## Error Handling

```python
from cavendo import CavendoClient, CavendoError, AuthenticationError, CavendoConnectionError

try:
    client = CavendoClient(url="http://localhost:3001", api_key="invalid")
    client.tasks.list_all()
except AuthenticationError as e:
    print(f"Auth failed: {e.message}")
except CavendoError as e:
    print(f"API error: {e.message} (status: {e.status_code})")
```

### Exception Types

| Exception | Description |
|-----------|-------------|
| `CavendoError` | Base exception for all API errors |
| `AuthenticationError` | Invalid or expired API key |
| `AuthorizationError` | Insufficient permissions |
| `NotFoundError` | Resource not found |
| `ValidationError` | Invalid request parameters |
| `RateLimitError` | Rate limit exceeded |
| `ServerError` | Server error (5xx) |
| `CavendoConnectionError` | Network connection failed |
| `CavendoTimeoutError` | Request timed out |

## Integration Examples

### CrewAI Integration

```python
from crewai import Agent, Task, Crew
from cavendo import CavendoClient

cavendo = CavendoClient()  # Reads from CAVENDO_URL and CAVENDO_AGENT_KEY env vars

class CavendoAgent(Agent):
    def execute_task(self, task_description: str) -> str:
        # Get task from Cavendo
        task = cavendo.tasks.next()
        if not task:
            return "No tasks available"

        context = cavendo.tasks.context(task.id)

        # Mark in progress
        cavendo.tasks.update_status(task.id, 'in_progress')

        # Execute with CrewAI
        result = super().execute_task(task.description)

        # Submit to Cavendo
        cavendo.deliverables.submit(
            task_id=task.id,
            title=task.title,
            content=result
        )

        return result
```

### LangChain Integration

```python
from langchain.agents import AgentExecutor
from langchain.tools import Tool
from cavendo import CavendoClient

cavendo = CavendoClient()  # Reads from CAVENDO_URL and CAVENDO_AGENT_KEY env vars

def get_next_task(_: str) -> str:
    task = cavendo.tasks.next()
    if task:
        return f"Task: {task.title}\n{task.description}"
    return "No tasks available"

def submit_deliverable(content: str) -> str:
    # Assumes task_id is tracked elsewhere
    cavendo.deliverables.submit(
        task_id=current_task_id,
        title="LangChain Output",
        content=content
    )
    return "Deliverable submitted"

tools = [
    Tool(name="get_task", func=get_next_task, description="Get next assigned task"),
    Tool(name="submit", func=submit_deliverable, description="Submit work for review"),
]
```

### Async Support

The client provides `*_async` methods for all operations:

```python
import asyncio
from cavendo import CavendoClient

async def main():
    # Use async context manager
    async with CavendoClient() as client:
        # Async operations use *_async suffix
        task = await client.tasks.next_async()

        if task:
            context = await client.tasks.context_async(task.id)
            await client.tasks.update_status_async(task.id, 'in_progress')

            # Do async work...
            result = await do_async_work(context)

            await client.deliverables.submit_async(
                task_id=task.id,
                title="Async Result",
                content=result
            )

asyncio.run(main())
```

## Complete Workflow Example

```python
from cavendo import CavendoClient
import time

client = CavendoClient()  # Reads from CAVENDO_URL and CAVENDO_AGENT_KEY env vars

def agent_loop():
    """Main agent loop - poll for tasks and process them."""
    while True:
        # Check for tasks
        task = client.tasks.next()

        if not task:
            print("No tasks available, waiting...")
            time.sleep(30)
            continue

        print(f"Processing: {task.title}")

        try:
            # Get full context
            context = client.tasks.context(task.id)

            # Mark in progress
            client.tasks.update_status(task.id, 'in_progress')

            # Process the task (your AI logic here)
            output = process_task(task, context)

            # Submit deliverable
            client.deliverables.submit(
                task_id=task.id,
                title=f"{task.title} - Complete",
                content=output
            )

            print(f"Submitted deliverable for task {task.id}")

        except Exception as e:
            print(f"Error processing task {task.id}: {e}")
            # Task stays in progress, human can reassign

        # Brief pause before next task
        time.sleep(5)

def process_task(task, context):
    """Your AI processing logic here."""
    # Access task details
    title = task.title
    description = task.description

    # Access project knowledge
    knowledge = context.knowledge

    # Access previous deliverables (for revisions)
    previous = context.previous_deliverables

    # Check if this is a revision
    if previous:
        last = previous[0]
        if last.status == 'revision_requested':
            feedback = client.deliverables.get_feedback(last.id)
            # Incorporate feedback...

    # Your AI logic here
    return f"## {title}\n\nCompleted analysis based on {len(knowledge)} knowledge docs."

if __name__ == "__main__":
    agent_loop()
```
