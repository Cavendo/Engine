"""
Webhooks API for the Cavendo SDK.

This module provides methods for managing webhooks.
Note: Webhook management requires the 'webhook:create' scope.
"""

from typing import TYPE_CHECKING, Any, Optional, Union

from .types import Webhook, WebhookEvent

if TYPE_CHECKING:
    from .client import CavendoClient


class WebhooksAPI:
    """
    API for managing webhooks.

    This class provides methods to create, list, update, and delete webhooks.
    Requires the 'webhook:create' scope. All methods support both synchronous
    and asynchronous usage.
    """

    def __init__(self, client: "CavendoClient") -> None:
        """
        Initialize the Webhooks API.

        Args:
            client: The CavendoClient instance to use for API calls.
        """
        self._client = client

    def list_all(self) -> list[Webhook]:
        """
        List all webhooks created by this agent.

        Returns:
            List of Webhook objects.

        Raises:
            AuthorizationError: If the agent lacks webhook permissions.

        Example:
            >>> webhooks = client.webhooks.list_all()
            >>> for webhook in webhooks:
            ...     print(f"{webhook.id}: {webhook.url}")
            ...     print(f"  Events: {', '.join(webhook.events)}")
        """
        data = self._client._request_json("GET", "/api/webhooks/mine")

        webhooks_data = data if isinstance(data, list) else data.get("webhooks", [])
        return [Webhook.from_dict(w) for w in webhooks_data]

    async def list_all_async(self) -> list[Webhook]:
        """
        Async version of list_all().

        See list_all() for documentation.
        """
        data = await self._client._request_json_async("GET", "/api/webhooks/mine")

        webhooks_data = data if isinstance(data, list) else data.get("webhooks", [])
        return [Webhook.from_dict(w) for w in webhooks_data]

    def create(
        self,
        url: str,
        events: list[Union[str, WebhookEvent]],
        active: bool = True,
    ) -> Webhook:
        """
        Create a new webhook.

        Args:
            url: The URL to send webhook events to.
            events: List of event types to subscribe to.
            active: Whether the webhook should be active (default True).

        Returns:
            The created Webhook (includes the secret for verification).

        Raises:
            AuthorizationError: If the agent lacks webhook permissions.
            ValidationError: If the URL or events are invalid.

        Example:
            >>> webhook = client.webhooks.create(
            ...     url="https://example.com/webhook",
            ...     events=["task.assigned", "deliverable.approved"]
            ... )
            >>> print(f"Created webhook {webhook.id}")
            >>> print(f"Secret: {webhook.secret}")  # Save this!
        """
        event_values = [e.value if isinstance(e, WebhookEvent) else e for e in events]

        body: dict[str, Any] = {
            "url": url,
            "events": event_values,
            # Server expects "status" field with "active"/"inactive" values
            "status": "active" if active else "inactive",
        }

        data = self._client._request_json("POST", "/api/webhooks/mine", json=body)
        return Webhook.from_dict(data)

    async def create_async(
        self,
        url: str,
        events: list[Union[str, WebhookEvent]],
        active: bool = True,
    ) -> Webhook:
        """
        Async version of create().

        See create() for documentation.
        """
        event_values = [e.value if isinstance(e, WebhookEvent) else e for e in events]

        body: dict[str, Any] = {
            "url": url,
            "events": event_values,
            # Server expects "status" field with "active"/"inactive" values
            "status": "active" if active else "inactive",
        }

        data = await self._client._request_json_async("POST", "/api/webhooks/mine", json=body)
        return Webhook.from_dict(data)

    def update(
        self,
        webhook_id: int,
        url: Optional[str] = None,
        events: Optional[list[Union[str, WebhookEvent]]] = None,
        active: Optional[bool] = None,
    ) -> Webhook:
        """
        Update an existing webhook.

        Args:
            webhook_id: The webhook ID to update.
            url: New URL (optional).
            events: New event list (optional).
            active: New active status (optional).

        Returns:
            The updated Webhook.

        Raises:
            AuthorizationError: If the agent lacks webhook permissions.
            NotFoundError: If the webhook doesn't exist.

        Example:
            >>> # Disable a webhook
            >>> webhook = client.webhooks.update(1, active=False)

            >>> # Change subscribed events
            >>> webhook = client.webhooks.update(
            ...     1,
            ...     events=["task.assigned"]
            ... )
        """
        body: dict[str, Any] = {}
        if url is not None:
            body["url"] = url
        if events is not None:
            body["events"] = [e.value if isinstance(e, WebhookEvent) else e for e in events]
        if active is not None:
            # Server expects "status" field with "active"/"inactive" values
            body["status"] = "active" if active else "inactive"

        data = self._client._request_json("PATCH", f"/api/webhooks/mine/{webhook_id}", json=body)
        return Webhook.from_dict(data)

    async def update_async(
        self,
        webhook_id: int,
        url: Optional[str] = None,
        events: Optional[list[Union[str, WebhookEvent]]] = None,
        active: Optional[bool] = None,
    ) -> Webhook:
        """
        Async version of update().

        See update() for documentation.
        """
        body: dict[str, Any] = {}
        if url is not None:
            body["url"] = url
        if events is not None:
            body["events"] = [e.value if isinstance(e, WebhookEvent) else e for e in events]
        if active is not None:
            # Server expects "status" field with "active"/"inactive" values
            body["status"] = "active" if active else "inactive"

        data = await self._client._request_json_async(
            "PATCH", f"/api/webhooks/mine/{webhook_id}", json=body
        )
        return Webhook.from_dict(data)

    def delete(self, webhook_id: int) -> None:
        """
        Delete a webhook.

        Args:
            webhook_id: The webhook ID to delete.

        Raises:
            AuthorizationError: If the agent lacks webhook permissions.
            NotFoundError: If the webhook doesn't exist.

        Example:
            >>> client.webhooks.delete(1)
            >>> print("Webhook deleted")
        """
        self._client._request("DELETE", f"/api/webhooks/mine/{webhook_id}")

    async def delete_async(self, webhook_id: int) -> None:
        """
        Async version of delete().

        See delete() for documentation.
        """
        await self._client._request_async("DELETE", f"/api/webhooks/mine/{webhook_id}")
