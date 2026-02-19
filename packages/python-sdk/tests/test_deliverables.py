"""Tests for the DeliverablesAPI class."""

import pytest
from pytest_httpx import HTTPXMock

from cavendo import CavendoClient
from cavendo.types import ContentType, Deliverable, Feedback


class TestDeliverablesSubmit:
    """Tests for deliverables.submit() method."""

    def test_submit_returns_deliverable(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_deliverable_response: dict
    ) -> None:
        """Test that submit() returns a Deliverable object."""
        httpx_mock.add_response(json=mock_deliverable_response)
        deliverable = client.deliverables.submit(
            task_id=123,
            title="Test Deliverable",
            content="# Test Content",
        )
        assert isinstance(deliverable, Deliverable)
        assert deliverable.id == 456
        assert deliverable.task_id == 123

    def test_submit_with_content_type_enum(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_deliverable_response: dict
    ) -> None:
        """Test submit() with ContentType enum."""
        httpx_mock.add_response(json=mock_deliverable_response)
        client.deliverables.submit(
            task_id=123,
            title="Test",
            content="content",
            content_type=ContentType.CODE,
        )
        request = httpx_mock.get_request()
        assert request is not None

    def test_submit_with_metadata(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_deliverable_response: dict
    ) -> None:
        """Test submit() with metadata."""
        httpx_mock.add_response(json=mock_deliverable_response)
        client.deliverables.submit(
            task_id=123,
            title="Test",
            content="content",
            metadata={"sources": ["https://example.com"]},
        )
        request = httpx_mock.get_request()
        assert request is not None


class TestDeliverablesGet:
    """Tests for deliverables.get() method."""

    def test_get_returns_deliverable(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_deliverable_response: dict
    ) -> None:
        """Test that get() returns a Deliverable object."""
        httpx_mock.add_response(json=mock_deliverable_response)
        deliverable = client.deliverables.get(456)
        assert isinstance(deliverable, Deliverable)
        assert deliverable.id == 456


class TestDeliverablesGetFeedback:
    """Tests for deliverables.get_feedback() method."""

    def test_get_feedback_returns_feedback(
        self, client: CavendoClient, httpx_mock: HTTPXMock
    ) -> None:
        """Test that get_feedback() returns a Feedback object."""
        feedback_data = {
            "success": True,
            "data": {
                "id": 456,
                "status": "revision_requested",
                "feedback": "Please add more details",
                "reviewedBy": "user@example.com",
                "reviewedAt": "2025-01-15T00:00:00Z",
            },
        }
        httpx_mock.add_response(json=feedback_data)
        feedback = client.deliverables.get_feedback(456)
        assert feedback is not None
        assert isinstance(feedback, Feedback)
        assert feedback.status == "revision_requested"
        assert feedback.content == "Please add more details"

    def test_get_feedback_returns_none_when_no_feedback(
        self, client: CavendoClient, httpx_mock: HTTPXMock
    ) -> None:
        """Test that get_feedback() returns None when no feedback exists."""
        httpx_mock.add_response(json={"success": True, "data": {}})
        feedback = client.deliverables.get_feedback(456)
        assert feedback is None


class TestDeliverablesSubmitRevision:
    """Tests for deliverables.submit_revision() method."""

    def test_submit_revision_returns_updated_deliverable(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_deliverable_response: dict
    ) -> None:
        """Test that submit_revision() returns updated Deliverable."""
        revised = mock_deliverable_response.copy()
        revised["data"]["version"] = 2
        httpx_mock.add_response(json=revised)
        deliverable = client.deliverables.submit_revision(
            deliverable_id=456,
            content="# Updated Content",
        )
        assert isinstance(deliverable, Deliverable)
        assert deliverable.version == 2


class TestDeliverablesMine:
    """Tests for deliverables.mine() method."""

    def test_mine_returns_deliverables(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_deliverable_response: dict
    ) -> None:
        """Test that mine() returns a list of Deliverable objects."""
        httpx_mock.add_response(
            json={"success": True, "data": [mock_deliverable_response["data"]]}
        )
        deliverables = client.deliverables.mine()
        assert len(deliverables) == 1
        assert isinstance(deliverables[0], Deliverable)

    def test_mine_with_filters(
        self, client: CavendoClient, httpx_mock: HTTPXMock
    ) -> None:
        """Test mine() with status and task_id filters."""
        httpx_mock.add_response(json={"success": True, "data": []})
        client.deliverables.mine(status="pending", task_id=123)
        request = httpx_mock.get_request()
        assert request is not None
        assert "status=pending" in str(request.url)
        assert "taskId=123" in str(request.url)
