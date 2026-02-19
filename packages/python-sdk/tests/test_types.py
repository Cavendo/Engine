"""Tests for the types module (dataclasses)."""

import pytest

from cavendo.types import (
    Agent,
    ContentType,
    Deliverable,
    DeliverableStatus,
    Feedback,
    KnowledgeDocument,
    SearchResult,
    Task,
    TaskContext,
    TaskStatus,
    Webhook,
    WebhookEvent,
)


class TestAgentFromDict:
    """Tests for Agent.from_dict()."""

    def test_from_dict_basic(self) -> None:
        """Test Agent.from_dict() with basic data."""
        data = {
            "id": 1,
            "name": "Test Agent",
            "type": "autonomous",
            "scopes": ["task:read", "task:write"],
            "projectIds": [1, 2],
            "createdAt": "2025-01-01T00:00:00Z",
        }
        agent = Agent.from_dict(data)
        assert agent.id == 1
        assert agent.name == "Test Agent"
        assert agent.type == "autonomous"
        assert agent.scopes == ["task:read", "task:write"]
        assert agent.project_ids == [1, 2]

    def test_from_dict_handles_missing_optional_fields(self) -> None:
        """Test Agent.from_dict() handles missing optional fields."""
        data = {
            "id": 1,
            "name": "Test",
            "type": "supervised",
        }
        agent = Agent.from_dict(data)
        assert agent.scopes == []
        assert agent.project_ids == []
        assert agent.metadata == {}


class TestTaskFromDict:
    """Tests for Task.from_dict()."""

    def test_from_dict_complete(self) -> None:
        """Test Task.from_dict() with complete data."""
        data = {
            "id": 123,
            "title": "Test Task",
            "description": "Description",
            "status": "pending",
            "priority": 2,
            "projectId": 1,
            "projectName": "Project",
            "assigneeId": 1,
            "dueDate": "2025-02-01T00:00:00Z",
            "progress": {"steps_completed": 2},
            "metadata": {"key": "value"},
            "createdAt": "2025-01-01T00:00:00Z",
            "updatedAt": "2025-01-01T00:00:00Z",
        }
        task = Task.from_dict(data)
        assert task.id == 123
        assert task.title == "Test Task"
        assert task.status == TaskStatus.PENDING
        assert task.metadata == {"key": "value"}
        assert task.project_id == 1
        assert task.assignee_id == 1


class TestDeliverableFromDict:
    """Tests for Deliverable.from_dict()."""

    def test_from_dict_complete(self) -> None:
        """Test Deliverable.from_dict() with complete data."""
        data = {
            "id": 456,
            "taskId": 123,
            "title": "Deliverable",
            "content": "# Content",
            "contentType": "markdown",
            "status": "pending",
            "version": 1,
            "feedback": None,
            "metadata": {},
            "createdAt": "2025-01-01T00:00:00Z",
            "updatedAt": "2025-01-01T00:00:00Z",
        }
        deliverable = Deliverable.from_dict(data)
        assert deliverable.id == 456
        assert deliverable.task_id == 123
        assert deliverable.content_type == ContentType.MARKDOWN


class TestFeedbackFromDict:
    """Tests for Feedback.from_dict()."""

    def test_from_dict_with_feedback(self) -> None:
        """Test Feedback.from_dict() with feedback content."""
        data = {
            "id": 456,
            "deliverableId": 123,
            "status": "revision_requested",
            "feedback": "Please revise",
            "reviewerId": 1,
            "reviewerName": "Test User",
            "createdAt": "2025-01-15T00:00:00Z",
        }
        feedback = Feedback.from_dict(data)
        assert feedback.id == 456
        assert feedback.deliverable_id == 123
        assert feedback.status == DeliverableStatus.REVISION_REQUESTED
        assert feedback.content == "Please revise"

    def test_from_dict_with_content_key(self) -> None:
        """Test Feedback.from_dict() supports 'content' key as alternative to 'feedback'."""
        data = {
            "id": 456,
            "deliverableId": 123,
            "status": "approved",
            "content": "Looks good!",
            "reviewerId": 1,
            "createdAt": "2025-01-15T00:00:00Z",
        }
        feedback = Feedback.from_dict(data)
        assert feedback.content == "Looks good!"

    def test_from_dict_with_none_feedback(self) -> None:
        """Test Feedback.from_dict() with None feedback."""
        data = {
            "id": 456,
            "deliverableId": 123,
            "status": "approved",
            "feedback": None,
            "reviewerId": 1,
            "createdAt": "2025-01-15T00:00:00Z",
        }
        feedback = Feedback.from_dict(data)
        assert feedback.content == ""


class TestKnowledgeDocumentFromDict:
    """Tests for KnowledgeDocument.from_dict()."""

    def test_from_dict_complete(self) -> None:
        """Test KnowledgeDocument.from_dict() with complete data."""
        data = {
            "id": 789,
            "projectId": 1,
            "title": "Document",
            "content": "# Content",
            "contentType": "markdown",
            "tags": ["test"],
            "metadata": {"source": "api"},
            "createdAt": "2025-01-01T00:00:00Z",
            "updatedAt": "2025-01-01T00:00:00Z",
        }
        doc = KnowledgeDocument.from_dict(data)
        assert doc.id == 789
        assert doc.content_type == ContentType.MARKDOWN
        assert doc.tags == ["test"]
        assert doc.project_id == 1


class TestEnums:
    """Tests for enum values."""

    def test_task_status_values(self) -> None:
        """Test TaskStatus enum values."""
        assert TaskStatus.PENDING.value == "pending"
        assert TaskStatus.IN_PROGRESS.value == "in_progress"
        assert TaskStatus.REVIEW.value == "review"
        assert TaskStatus.COMPLETED.value == "completed"

    def test_deliverable_status_values(self) -> None:
        """Test DeliverableStatus enum values."""
        assert DeliverableStatus.PENDING.value == "pending"
        assert DeliverableStatus.APPROVED.value == "approved"
        assert DeliverableStatus.REVISION_REQUESTED.value == "revision_requested"
        assert DeliverableStatus.REJECTED.value == "rejected"

    def test_content_type_values(self) -> None:
        """Test ContentType enum values."""
        assert ContentType.MARKDOWN.value == "markdown"
        assert ContentType.HTML.value == "html"
        assert ContentType.JSON.value == "json"
        assert ContentType.TEXT.value == "text"
        assert ContentType.CODE.value == "code"

    def test_webhook_event_values(self) -> None:
        """Test WebhookEvent enum values."""
        assert WebhookEvent.TASK_ASSIGNED.value == "task.assigned"
        assert WebhookEvent.DELIVERABLE_APPROVED.value == "deliverable.approved"
