"""
Type definitions for the Cavendo SDK.

This module contains dataclasses and type definitions used throughout
the SDK to provide structured data and type safety.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, List, Optional, TypedDict


class TaskStatus(str, Enum):
    """Valid status values for tasks."""

    PENDING = "pending"
    ASSIGNED = "assigned"
    IN_PROGRESS = "in_progress"
    REVIEW = "review"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class DeliverableStatus(str, Enum):
    """Valid status values for deliverables."""

    PENDING = "pending"
    APPROVED = "approved"
    REVISION_REQUESTED = "revision_requested"
    REJECTED = "rejected"


class ContentType(str, Enum):
    """Valid content types for deliverables."""

    MARKDOWN = "markdown"
    HTML = "html"
    JSON = "json"
    TEXT = "text"
    CODE = "code"


class WebhookEvent(str, Enum):
    """Valid webhook event types."""

    TASK_ASSIGNED = "task.assigned"
    TASK_UPDATED = "task.updated"
    TASK_CLAIMED = "task.claimed"
    TASK_PROGRESS_UPDATED = "task.progress_updated"
    DELIVERABLE_APPROVED = "deliverable.approved"
    DELIVERABLE_REVISION_REQUESTED = "deliverable.revision_requested"
    DELIVERABLE_REJECTED = "deliverable.rejected"
    SPRINT_STARTED = "sprint.started"
    PROJECT_KNOWLEDGE_UPDATED = "project.knowledge_updated"
    BRIEFING_GENERATED = "briefing.generated"


class FileAttachment(TypedDict, total=False):
    """
    A file attachment for a deliverable.

    Attributes:
        filename: Filename with extension (e.g., "landing-page.html", "styles.css").
        content: The complete file content. For binary files, prefix with "base64:".
        mimeType: Optional MIME type. Auto-detected from extension if not provided.
    """

    filename: str  # Required
    content: str  # Required
    mimeType: str  # Optional


class ActionItem(TypedDict, total=False):
    """
    A follow-up action item for a deliverable.

    Attributes:
        action_text: The action item text (e.g., "Review the landing page copy").
        estimated_time_minutes: Estimated time in minutes (default: 25).
        notes: Additional context or instructions.
    """

    action_text: str  # Required
    estimated_time_minutes: int  # Optional
    notes: str  # Optional


@dataclass
class Agent:
    """
    Represents the authenticated agent.

    Attributes:
        id: Unique identifier for the agent.
        name: Display name of the agent.
        type: Agent type (e.g., "ai", "human").
        scopes: List of permission scopes granted to the agent.
        project_ids: List of project IDs the agent has access to.
        metadata: Additional agent metadata.
        created_at: When the agent was created.
    """

    id: int
    name: str
    type: str
    scopes: list[str] = field(default_factory=list)
    project_ids: list[int] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: Optional[datetime] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Agent":
        """Create an Agent from an API response dictionary."""
        return cls(
            id=data["id"],
            name=data["name"],
            type=data.get("type", "ai"),
            scopes=data.get("scopes", []),
            project_ids=data.get("projectIds", data.get("project_ids", [])),
            metadata=data.get("metadata", {}),
            created_at=_parse_datetime(data.get("createdAt") or data.get("created_at")),
        )


@dataclass
class Task:
    """
    Represents a task assigned to an agent.

    Attributes:
        id: Unique task identifier.
        title: Task title/summary.
        description: Detailed task description.
        status: Current task status.
        priority: Task priority (1-5, higher is more urgent).
        project_id: Associated project ID.
        project_name: Associated project name.
        assignee_id: ID of the assigned agent.
        due_date: Task due date if set.
        progress: Progress metadata (steps completed, etc.).
        metadata: Additional task metadata.
        created_at: When the task was created.
        updated_at: When the task was last updated.
    """

    id: int
    title: str
    description: Optional[str] = None
    status: TaskStatus = TaskStatus.PENDING
    priority: int = 3
    project_id: Optional[int] = None
    project_name: Optional[str] = None
    assignee_id: Optional[int] = None
    due_date: Optional[datetime] = None
    progress: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Task":
        """Create a Task from an API response dictionary."""
        status_value = data.get("status", "pending")
        try:
            status = TaskStatus(status_value)
        except ValueError:
            status = TaskStatus.PENDING

        return cls(
            id=data["id"],
            title=data["title"],
            description=data.get("description"),
            status=status,
            priority=data.get("priority", 3),
            project_id=data.get("projectId") or data.get("project_id"),
            project_name=data.get("projectName") or data.get("project_name"),
            # Server may return assigneeId, assignee_id, assignedAgentId, or assigned_agent_id
            assignee_id=(
                data.get("assigneeId")
                or data.get("assignee_id")
                or data.get("assignedAgentId")
                or data.get("assigned_agent_id")
            ),
            due_date=_parse_datetime(data.get("dueDate") or data.get("due_date")),
            progress=data.get("progress", {}),
            metadata=data.get("metadata", {}),
            created_at=_parse_datetime(data.get("createdAt") or data.get("created_at")),
            updated_at=_parse_datetime(data.get("updatedAt") or data.get("updated_at")),
        )


@dataclass
class AgentProfile:
    """
    Profile information for an agent assigned to a task.

    Attributes:
        id: Unique identifier for the agent.
        name: Display name of the agent.
        type: Agent type (e.g., "ai", "human").
        description: Agent description.
        capabilities: List of agent capabilities.
        specializations: Agent specialization details.
        system_prompt: System prompt for AI agents.
        metadata: Additional agent metadata.
    """

    id: int
    name: str
    type: Optional[str] = None
    description: Optional[str] = None
    capabilities: list[str] = field(default_factory=list)
    specializations: dict[str, Any] = field(default_factory=dict)
    system_prompt: Optional[str] = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AgentProfile":
        """Create an AgentProfile from an API response dictionary."""
        return cls(
            id=data["id"],
            name=data["name"],
            type=data.get("type"),
            description=data.get("description"),
            capabilities=data.get("capabilities", []),
            specializations=data.get("specializations", {}),
            system_prompt=data.get("systemPrompt") or data.get("system_prompt"),
            metadata=data.get("metadata", {}),
        )


@dataclass
class SprintInfo:
    """
    Basic sprint information included in task context.

    Attributes:
        id: Unique identifier for the sprint.
        name: Sprint name.
    """

    id: int
    name: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SprintInfo":
        """Create a SprintInfo from an API response dictionary."""
        return cls(
            id=data["id"],
            name=data["name"],
        )


@dataclass
class TaskContext:
    """
    Extended context for a task, including related information.

    Attributes:
        task: The task itself.
        agent: Profile of the agent assigned to the task.
        project: Project details.
        sprint: Sprint information if task is in a sprint.
        related_tasks: Other tasks related to this one.
        knowledge: Relevant knowledge documents.
        previous_deliverables: Prior deliverables for this task.
    """

    task: Task
    agent: Optional[AgentProfile] = None
    project: Optional[dict[str, Any]] = None
    sprint: Optional[SprintInfo] = None
    related_tasks: list[Task] = field(default_factory=list)
    knowledge: list["KnowledgeDocument"] = field(default_factory=list)
    previous_deliverables: list["Deliverable"] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TaskContext":
        """Create TaskContext from an API response dictionary."""
        # Server may return deliverables under "deliverables" or "previousDeliverables"
        deliverables_data = data.get("deliverables", data.get("previousDeliverables", []))

        # Parse agent profile if present
        agent_data = data.get("agent")
        agent = AgentProfile.from_dict(agent_data) if agent_data else None

        # Parse sprint info if present
        sprint_data = data.get("sprint")
        sprint = SprintInfo.from_dict(sprint_data) if sprint_data else None

        return cls(
            task=Task.from_dict(data["task"]),
            agent=agent,
            project=data.get("project"),
            sprint=sprint,
            related_tasks=[Task.from_dict(t) for t in data.get("relatedTasks", [])],
            knowledge=[KnowledgeDocument.from_dict(k) for k in data.get("knowledge", [])],
            previous_deliverables=[
                Deliverable.from_dict(d) for d in deliverables_data
            ],
        )


@dataclass
class Deliverable:
    """
    Represents a deliverable submitted by an agent.

    Attributes:
        id: Unique deliverable identifier.
        task_id: Associated task ID.
        title: Deliverable title.
        content: The deliverable content.
        content_type: Type of content (markdown, html, etc.).
        status: Current deliverable status.
        version: Version number (increments with revisions).
        metadata: Additional metadata (sources, etc.).
        feedback: Latest feedback if any.
        created_at: When the deliverable was created.
        updated_at: When the deliverable was last updated.
    """

    id: int
    task_id: Optional[int] = None
    title: str = ""
    content: Optional[str] = None
    content_type: ContentType = ContentType.MARKDOWN
    status: DeliverableStatus = DeliverableStatus.PENDING
    version: int = 1
    metadata: dict[str, Any] = field(default_factory=dict)
    feedback: Optional[str] = None
    summary: Optional[str] = None
    files: Optional[list[dict[str, Any]]] = None
    actions: Optional[list[dict[str, Any]]] = None
    project_id: Optional[int] = None
    agent_id: Optional[int] = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Deliverable":
        """Create a Deliverable from an API response dictionary."""
        content_type_value = data.get("contentType") or data.get("content_type", "markdown")
        try:
            content_type = ContentType(content_type_value)
        except ValueError:
            content_type = ContentType.MARKDOWN

        status_value = data.get("status", "pending")
        try:
            status = DeliverableStatus(status_value)
        except ValueError:
            status = DeliverableStatus.PENDING

        # Handle task_id - now optional for standalone deliverables
        task_id_value = data.get("taskId") or data.get("task_id")

        return cls(
            id=data["id"],
            task_id=task_id_value,
            title=data["title"],
            content=data.get("content"),
            content_type=content_type,
            status=status,
            version=data.get("version", 1),
            metadata=data.get("metadata", {}),
            feedback=data.get("feedback"),
            summary=data.get("summary"),
            files=data.get("files"),
            actions=data.get("actions"),
            project_id=data.get("projectId") or data.get("project_id"),
            agent_id=data.get("agentId") or data.get("agent_id"),
            input_tokens=data.get("inputTokens") or data.get("input_tokens"),
            output_tokens=data.get("outputTokens") or data.get("output_tokens"),
            provider=data.get("provider"),
            model=data.get("model"),
            created_at=_parse_datetime(data.get("createdAt") or data.get("created_at")),
            updated_at=_parse_datetime(data.get("updatedAt") or data.get("updated_at")),
        )


@dataclass
class Feedback:
    """
    Feedback on a deliverable.

    Attributes:
        id: Unique feedback identifier.
        deliverable_id: Associated deliverable ID.
        content: Feedback content/comments.
        status: Resulting status (approved, rejected, revision_requested).
        reviewer_id: ID of the reviewer.
        reviewer_name: Name of the reviewer.
        created_at: When the feedback was given.
    """

    id: int
    deliverable_id: int
    content: str
    status: DeliverableStatus
    reviewer_id: Optional[int] = None
    reviewer_name: Optional[str] = None
    created_at: Optional[datetime] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Feedback":
        """Create Feedback from an API response dictionary."""
        status_value = data.get("status", "pending")
        try:
            status = DeliverableStatus(status_value)
        except ValueError:
            status = DeliverableStatus.PENDING

        # Handle deliverable_id - required field with fallback
        deliverable_id_value = data.get("deliverableId") or data.get("deliverable_id")
        if deliverable_id_value is None:
            deliverable_id_value = 0  # Default for missing required field

        # Support both "content" and "feedback" keys for the content field
        content_value = data.get("content") or data.get("feedback") or ""

        return cls(
            id=data["id"],
            deliverable_id=deliverable_id_value,
            content=content_value,
            status=status,
            reviewer_id=data.get("reviewerId") or data.get("reviewer_id"),
            reviewer_name=data.get("reviewerName") or data.get("reviewer_name"),
            created_at=_parse_datetime(data.get("createdAt") or data.get("created_at")),
        )


@dataclass
class KnowledgeDocument:
    """
    A knowledge document from the knowledge base.

    Attributes:
        id: Unique document identifier.
        title: Document title.
        content: Document content.
        content_type: Type of content.
        project_id: Associated project ID if any.
        tags: Document tags for categorization.
        metadata: Additional metadata.
        created_at: When the document was created.
        updated_at: When the document was last updated.
    """

    id: int
    title: str
    content: str
    content_type: ContentType = ContentType.MARKDOWN
    project_id: Optional[int] = None
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "KnowledgeDocument":
        """Create a KnowledgeDocument from an API response dictionary."""
        content_type_value = data.get("contentType") or data.get("content_type", "markdown")
        try:
            content_type = ContentType(content_type_value)
        except ValueError:
            content_type = ContentType.MARKDOWN

        return cls(
            id=data["id"],
            title=data["title"],
            content=data["content"],
            content_type=content_type,
            project_id=data.get("projectId") or data.get("project_id"),
            tags=data.get("tags", []),
            metadata=data.get("metadata", {}),
            created_at=_parse_datetime(data.get("createdAt") or data.get("created_at")),
            updated_at=_parse_datetime(data.get("updatedAt") or data.get("updated_at")),
        )


@dataclass
class SearchResult:
    """
    A search result from the knowledge base.

    Attributes:
        document: The matching knowledge document.
        score: Relevance score (0-1).
        highlights: Matching text snippets.
    """

    document: KnowledgeDocument
    score: float = 0.0
    highlights: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SearchResult":
        """Create a SearchResult from an API response dictionary."""
        return cls(
            document=KnowledgeDocument.from_dict(data.get("document", data)),
            score=data.get("score", 0.0),
            highlights=data.get("highlights", []),
        )


@dataclass
class Webhook:
    """
    A webhook configuration.

    Attributes:
        id: Unique webhook identifier.
        url: Webhook endpoint URL.
        events: List of events that trigger the webhook.
        active: Whether the webhook is active.
        secret: Webhook secret for verification (only on creation).
        created_at: When the webhook was created.
    """

    id: int
    url: str
    events: list[str] = field(default_factory=list)
    active: bool = True
    secret: Optional[str] = None
    created_at: Optional[datetime] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Webhook":
        """Create a Webhook from an API response dictionary."""
        # Server returns "status" field with "active"/"inactive" values
        # Convert to boolean "active" for SDK consistency
        status = data.get("status", "active")
        is_active = data.get("active", status == "active")
        return cls(
            id=data["id"],
            url=data["url"],
            events=data.get("events", []),
            active=is_active,
            secret=data.get("secret"),
            created_at=_parse_datetime(data.get("createdAt") or data.get("created_at")),
        )


def _parse_datetime(value: Optional[str]) -> Optional[datetime]:
    """Parse an ISO format datetime string."""
    if not value:
        return None
    try:
        # Handle various ISO formats
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        return datetime.fromisoformat(value)
    except (ValueError, TypeError):
        return None
