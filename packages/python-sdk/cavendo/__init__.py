"""
Cavendo Python SDK

A Python SDK for interacting with the Cavendo Engine API,
designed for use with AI agent frameworks like CrewAI, LangChain, and AutoGen.

Example:
    >>> from cavendo import CavendoClient
    >>>
    >>> client = CavendoClient(
    ...     url="http://localhost:3001",
    ...     api_key="cav_ak_..."
    ... )
    >>>
    >>> # Get next task
    >>> task = client.tasks.next()
    >>> if task:
    ...     client.tasks.update_status(task.id, "in_progress")
    ...     # ... do work ...
    ...     client.deliverables.submit(
    ...         task_id=task.id,
    ...         title="Result",
    ...         content="..."
    ...     )
"""

from .client import CavendoClient
from .deliverables import DeliverablesAPI
from .exceptions import (
    AuthenticationError,
    AuthorizationError,
    CavendoConnectionError,
    CavendoError,
    CavendoTimeoutError,
    NotFoundError,
    RateLimitError,
    ServerError,
    ValidationError,
)
from .knowledge import KnowledgeAPI
from .tasks import TasksAPI
from .types import (
    ActionItem,
    Agent,
    AgentProfile,
    ContentType,
    Deliverable,
    DeliverableStatus,
    Feedback,
    FileAttachment,
    KnowledgeDocument,
    SearchResult,
    SprintInfo,
    Task,
    TaskContext,
    TaskStatus,
    Webhook,
    WebhookEvent,
)
from .webhooks import WebhooksAPI

__version__ = "0.1.0"

__all__ = [
    # Main client
    "CavendoClient",
    # API classes
    "TasksAPI",
    "DeliverablesAPI",
    "KnowledgeAPI",
    "WebhooksAPI",
    # Types
    "ActionItem",
    "Agent",
    "AgentProfile",
    "ContentType",
    "Deliverable",
    "DeliverableStatus",
    "Feedback",
    "FileAttachment",
    "KnowledgeDocument",
    "SearchResult",
    "SprintInfo",
    "Task",
    "TaskContext",
    "TaskStatus",
    "Webhook",
    "WebhookEvent",
    # Exceptions
    "CavendoError",
    "AuthenticationError",
    "AuthorizationError",
    "NotFoundError",
    "ValidationError",
    "RateLimitError",
    "ServerError",
    "CavendoConnectionError",
    "CavendoTimeoutError",
]
