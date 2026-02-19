"""Tests for the WebhooksAPI class."""

import pytest
from pytest_httpx import HTTPXMock

from cavendo import CavendoClient
from cavendo.types import Webhook, WebhookEvent


@pytest.fixture
def mock_webhook_response() -> dict:
    """Mock webhook response data."""
    return {
        "success": True,
        "data": {
            "id": 1,
            "agentId": 1,
            "url": "https://example.com/webhook",
            "events": ["task.assigned", "deliverable.approved"],
            "secret": "whsec_test123",
            "active": True,
            "createdAt": "2025-01-01T00:00:00Z",
            "updatedAt": "2025-01-01T00:00:00Z",
        },
    }


class TestWebhooksListAll:
    """Tests for webhooks.list_all() method."""

    def test_list_all_returns_webhooks(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_webhook_response: dict
    ) -> None:
        """Test that list_all() returns a list of Webhook objects."""
        httpx_mock.add_response(
            json={"success": True, "data": [mock_webhook_response["data"]]}
        )
        webhooks = client.webhooks.list_all()
        assert len(webhooks) == 1
        assert isinstance(webhooks[0], Webhook)
        assert webhooks[0].id == 1
        assert webhooks[0].url == "https://example.com/webhook"


class TestWebhooksCreate:
    """Tests for webhooks.create() method."""

    def test_create_returns_webhook(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_webhook_response: dict
    ) -> None:
        """Test that create() returns a Webhook object."""
        httpx_mock.add_response(json=mock_webhook_response)
        webhook = client.webhooks.create(
            url="https://example.com/webhook",
            events=["task.assigned", "deliverable.approved"],
        )
        assert isinstance(webhook, Webhook)
        assert webhook.secret == "whsec_test123"

    def test_create_with_enum_events(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_webhook_response: dict
    ) -> None:
        """Test create() with WebhookEvent enum values."""
        httpx_mock.add_response(json=mock_webhook_response)
        client.webhooks.create(
            url="https://example.com/webhook",
            events=[WebhookEvent.TASK_ASSIGNED, WebhookEvent.DELIVERABLE_APPROVED],
        )
        request = httpx_mock.get_request()
        assert request is not None


class TestWebhooksUpdate:
    """Tests for webhooks.update() method."""

    def test_update_returns_updated_webhook(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_webhook_response: dict
    ) -> None:
        """Test that update() returns the updated Webhook."""
        updated = mock_webhook_response.copy()
        updated["data"]["active"] = False
        httpx_mock.add_response(json=updated)
        webhook = client.webhooks.update(1, active=False)
        assert isinstance(webhook, Webhook)
        assert webhook.active is False

    def test_update_url_and_events(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_webhook_response: dict
    ) -> None:
        """Test update() with new URL and events."""
        httpx_mock.add_response(json=mock_webhook_response)
        client.webhooks.update(
            1,
            url="https://new-url.com/webhook",
            events=["task.completed"],
        )
        request = httpx_mock.get_request()
        assert request is not None


class TestWebhooksDelete:
    """Tests for webhooks.delete() method."""

    def test_delete_succeeds(
        self, client: CavendoClient, httpx_mock: HTTPXMock
    ) -> None:
        """Test that delete() succeeds without error."""
        httpx_mock.add_response(status_code=204)
        # Should not raise
        client.webhooks.delete(1)
        request = httpx_mock.get_request()
        assert request is not None
        assert request.method == "DELETE"
