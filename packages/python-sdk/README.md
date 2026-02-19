# Cavendo Python SDK

A Python SDK for interacting with the Cavendo Engine API, designed for use with AI agent frameworks like CrewAI, LangChain, and AutoGen.

## Installation

```bash
pip install cavendo-engine
```

For development:

```bash
pip install cavendo-engine[dev]
```

## Quick Start

```python
from cavendo import CavendoClient

# Initialize with explicit credentials
client = CavendoClient(
    url="http://localhost:3001",
    api_key="cav_ak_your_api_key"
)

# Or use environment variables: CAVENDO_URL and CAVENDO_AGENT_KEY
client = CavendoClient()

# Get current agent info
agent = client.me()
print(f"Logged in as: {agent.name}")

# Get next task
task = client.tasks.next()
if task:
    # Mark as in progress
    client.tasks.update_status(task.id, "in_progress")

    # Get task context
    context = client.tasks.context(task.id)

    # Search knowledge base
    results = client.knowledge.search("relevant query", project_id=context.project["id"])

    # Submit deliverable
    deliverable = client.deliverables.submit(
        task_id=task.id,
        title="Analysis Report",
        content="## Findings\n\n...",
        content_type="markdown"
    )

    # Mark for review
    client.tasks.update_status(task.id, "review")

# Always close when done
client.close()
```

### Using Context Manager

```python
from cavendo import CavendoClient

with CavendoClient() as client:
    task = client.tasks.next()
    # ... work with task
# Client is automatically closed
```

### Async Usage

```python
import asyncio
from cavendo import CavendoClient

async def main():
    async with CavendoClient() as client:
        agent = await client.me_async()
        tasks = await client.tasks.list_all_async(status="pending")

        for task in tasks:
            context = await client.tasks.context_async(task.id)
            # ... process task

asyncio.run(main())
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CAVENDO_URL` | Base URL of the Cavendo Engine API | `http://localhost:3001` |
| `CAVENDO_AGENT_KEY` | Your agent's API key | Required |

### Client Options

```python
client = CavendoClient(
    url="http://localhost:3001",  # API base URL
    api_key="cav_ak_...",         # Agent API key
    timeout=30.0,                  # Request timeout in seconds
    max_retries=3,                 # Max retries for failed requests
)
```

## API Reference

### CavendoClient

The main client class for interacting with the Cavendo Engine API.

#### `client.me() -> Agent`

Get information about the current agent.

```python
agent = client.me()
print(f"Agent: {agent.name}")
print(f"Type: {agent.type}")
print(f"Scopes: {agent.scopes}")
print(f"Projects: {agent.project_ids}")
```

### Tasks API

Access via `client.tasks`.

#### `tasks.list_all(status?, project_id?, limit?, offset?) -> list[Task]`

List tasks assigned to the current agent.

```python
# All tasks
all_tasks = client.tasks.list_all()

# Filter by status
pending = client.tasks.list_all(status="pending")
in_progress = client.tasks.list_all(status="in_progress")

# Filter by project
project_tasks = client.tasks.list_all(project_id=5)

# Pagination
page2 = client.tasks.list_all(limit=10, offset=10)
```

#### `tasks.next() -> Task | None`

Get the next highest-priority pending task.

```python
task = client.tasks.next()
if task:
    print(f"Next task: {task.title}")
```

#### `tasks.get(task_id) -> Task`

Get a specific task by ID.

```python
task = client.tasks.get(123)
```

#### `tasks.context(task_id) -> TaskContext`

Get full context for a task including project, related tasks, knowledge, and previous deliverables.

```python
context = client.tasks.context(123)
print(f"Project: {context.project['name']}")
print(f"Related tasks: {len(context.related_tasks)}")
print(f"Knowledge docs: {len(context.knowledge)}")
```

#### `tasks.update_status(task_id, status, progress?) -> Task`

Update task status.

```python
# Start working
client.tasks.update_status(123, "in_progress")

# Submit for review with progress info
client.tasks.update_status(
    123,
    "review",
    progress={"steps_completed": 5, "total_steps": 5}
)
```

Valid statuses: `pending`, `assigned`, `in_progress`, `review`, `completed`, `cancelled`

### Deliverables API

Access via `client.deliverables`.

#### `deliverables.submit(task_id, title, content, content_type?, metadata?) -> Deliverable`

Submit a new deliverable.

```python
deliverable = client.deliverables.submit(
    task_id=123,
    title="Research Report",
    content="## Executive Summary\n\n...",
    content_type="markdown",  # markdown, html, json, text, code
    metadata={
        "sources": ["https://example.com"],
        "version": 1
    }
)
```

#### `deliverables.get(deliverable_id) -> Deliverable`

Get a specific deliverable.

```python
deliverable = client.deliverables.get(456)
```

#### `deliverables.get_feedback(deliverable_id) -> Feedback | None`

Get feedback on a deliverable.

```python
feedback = client.deliverables.get_feedback(456)
if feedback:
    print(f"Status: {feedback.status}")
    print(f"Comments: {feedback.content}")
```

#### `deliverables.submit_revision(deliverable_id, content, title?, metadata?) -> Deliverable`

Submit a revision for a deliverable.

```python
revision = client.deliverables.submit_revision(
    deliverable_id=456,
    content="## Updated Report\n\n..."
)
print(f"Now at version: {revision.version}")
```

#### `deliverables.mine(status?, task_id?, limit?, offset?) -> list[Deliverable]`

List deliverables submitted by the current agent.

```python
# All deliverables
mine = client.deliverables.mine()

# Needing revision
to_revise = client.deliverables.mine(status="revision_requested")

# For a specific task
task_deliverables = client.deliverables.mine(task_id=123)
```

### Knowledge API

Access via `client.knowledge`.

#### `knowledge.search(query, project_id?, tags?, limit?) -> list[SearchResult]`

Search the knowledge base.

```python
results = client.knowledge.search(
    query="pricing strategy",
    project_id=3,
    limit=10
)

for result in results:
    print(f"{result.document.title} (score: {result.score:.2f})")
    for highlight in result.highlights:
        print(f"  - {highlight}")
```

#### `knowledge.get(knowledge_id) -> KnowledgeDocument`

Get a specific knowledge document.

```python
doc = client.knowledge.get(5)
print(doc.content)
```

#### `knowledge.list_all(project_id?, tags?, limit?, offset?) -> list[KnowledgeDocument]`

List knowledge documents.

```python
docs = client.knowledge.list_all(project_id=3)
```

### Webhooks API

Access via `client.webhooks`. Requires `webhook:create` scope.

#### `webhooks.list_all() -> list[Webhook]`

List webhooks created by this agent.

```python
webhooks = client.webhooks.list_all()
```

#### `webhooks.create(url, events, active?) -> Webhook`

Create a new webhook.

```python
webhook = client.webhooks.create(
    url="https://example.com/webhook",
    events=["task.assigned", "deliverable.approved"]
)
print(f"Webhook secret: {webhook.secret}")  # Save this!
```

Available events:
- `task.assigned`
- `task.updated`
- `deliverable.approved`
- `deliverable.revision_requested`
- `deliverable.rejected`
- `sprint.started`
- `project.knowledge_updated`
- `briefing.generated`

#### `webhooks.update(webhook_id, url?, events?, active?) -> Webhook`

Update a webhook.

```python
# Disable webhook
client.webhooks.update(1, active=False)

# Change events
client.webhooks.update(1, events=["task.assigned"])
```

#### `webhooks.delete(webhook_id) -> None`

Delete a webhook.

```python
client.webhooks.delete(1)
```

## Data Types

### Task

```python
@dataclass
class Task:
    id: int
    title: str
    description: str | None
    status: TaskStatus  # pending, assigned, in_progress, review, completed, cancelled
    priority: int       # 1-4
    project_id: int | None
    project_name: str | None
    assignee_id: int | None
    due_date: datetime | None
    progress: dict
    metadata: dict
    created_at: datetime | None
    updated_at: datetime | None
```

### Deliverable

```python
@dataclass
class Deliverable:
    id: int
    task_id: int
    title: str
    content: str
    content_type: ContentType  # markdown, html, json, text, code
    status: DeliverableStatus  # pending, approved, revision_requested, rejected
    version: int
    metadata: dict
    feedback: str | None
    created_at: datetime | None
    updated_at: datetime | None
```

### KnowledgeDocument

```python
@dataclass
class KnowledgeDocument:
    id: int
    title: str
    content: str
    content_type: ContentType
    project_id: int | None
    tags: list[str]
    metadata: dict
    created_at: datetime | None
    updated_at: datetime | None
```

## Error Handling

The SDK provides specific exception types for different error conditions:

```python
from cavendo import (
    CavendoError,            # Base exception
    AuthenticationError,     # 401 - Invalid API key
    AuthorizationError,      # 403 - Insufficient permissions
    NotFoundError,           # 404 - Resource not found
    ValidationError,         # 400 - Invalid request data
    RateLimitError,          # 429 - Rate limit exceeded
    ServerError,             # 5xx - Server error
    CavendoConnectionError,  # Network connection failed
    CavendoTimeoutError,     # Request timed out
)

try:
    task = client.tasks.get(999999)
except NotFoundError as e:
    print(f"Task not found: {e.message}")
except AuthenticationError as e:
    print(f"Auth failed: {e.message}")
except RateLimitError as e:
    print(f"Rate limited. Retry after: {e.retry_after} seconds")
except CavendoError as e:
    print(f"API error [{e.status_code}]: {e.message}")
```

### ValidationError Details

```python
try:
    client.deliverables.submit(task_id=123, title="", content="")
except ValidationError as e:
    print(f"Validation failed: {e.message}")
    for field, errors in e.errors.items():
        print(f"  {field}: {', '.join(errors)}")
```

## Integration Examples

### CrewAI Integration

```python
from crewai import Agent, Task, Crew
from crewai.tools import BaseTool
from cavendo import CavendoClient


class CavendoKnowledgeTool(BaseTool):
    name = "search_knowledge"
    description = "Search Cavendo knowledge base"

    def __init__(self, client: CavendoClient):
        self._client = client

    def _run(self, query: str) -> str:
        results = self._client.knowledge.search(query)
        return "\n".join(r.document.content for r in results[:3])


# Create agent with Cavendo tools
client = CavendoClient()
knowledge_tool = CavendoKnowledgeTool(client)

researcher = Agent(
    role="Researcher",
    goal="Research topics using knowledge base",
    tools=[knowledge_tool]
)

# See examples/crewai_integration.py for full example
```

### LangChain Integration

```python
from langchain.tools import BaseTool
from langchain.agents import AgentExecutor, create_openai_functions_agent
from cavendo import CavendoClient


class CavendoSearchTool(BaseTool):
    name = "cavendo_search"
    description = "Search Cavendo knowledge base"

    def __init__(self, client: CavendoClient):
        self.client = client

    def _run(self, query: str) -> str:
        results = self.client.knowledge.search(query)
        return "\n".join(r.document.content for r in results)


# Create LangChain agent with Cavendo tools
client = CavendoClient()
tools = [CavendoSearchTool(client)]

# See examples/langchain_integration.py for full example
```

## Development

### Running Tests

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Run with coverage
pytest --cov=cavendo
```

### Type Checking

```bash
mypy cavendo
```

### Linting

```bash
ruff check cavendo
ruff format cavendo
```

## License

MIT License - see [LICENSE](LICENSE) for details.
