"""
Main client for the Cavendo SDK.

This module provides the CavendoClient class, the primary interface for
interacting with the Cavendo Engine API.
"""

import asyncio
import os
import time
from typing import Any, Optional

import httpx

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
from .types import Agent
from .webhooks import WebhooksAPI


class CavendoClient:
    """
    Main client for interacting with the Cavendo Engine API.

    This client provides access to all Cavendo API functionality including
    tasks, deliverables, knowledge base, and webhooks. It supports both
    synchronous and asynchronous usage patterns.

    Attributes:
        tasks: API for managing tasks.
        deliverables: API for managing deliverables.
        knowledge: API for searching and retrieving knowledge.
        webhooks: API for managing webhooks (requires webhook:create scope).

    Example:
        >>> from cavendo import CavendoClient
        >>>
        >>> # Initialize with explicit credentials
        >>> client = CavendoClient(
        ...     url="http://localhost:3001",
        ...     api_key="cav_ak_..."
        ... )
        >>>
        >>> # Or use environment variables
        >>> # CAVENDO_URL and CAVENDO_AGENT_KEY
        >>> client = CavendoClient()
        >>>
        >>> # Get current agent info
        >>> agent = client.me()
        >>> print(f"Logged in as {agent.name}")
        >>>
        >>> # Get next task
        >>> task = client.tasks.next()
        >>> if task:
        ...     context = client.tasks.context(task.id)
        ...     # ... do work ...
        ...     client.deliverables.submit(
        ...         task_id=task.id,
        ...         title="Result",
        ...         content="..."
        ...     )
    """

    def __init__(
        self,
        url: Optional[str] = None,
        api_key: Optional[str] = None,
        timeout: float = 30.0,
        max_retries: int = 3,
    ) -> None:
        """
        Initialize the Cavendo client.

        Args:
            url: Base URL of the Cavendo Engine API.
                 Falls back to CAVENDO_URL environment variable.
                 Defaults to http://localhost:3001.
            api_key: API key for authentication.
                     Falls back to CAVENDO_AGENT_KEY environment variable.
            timeout: Request timeout in seconds (default 30).
            max_retries: Maximum number of retries for failed requests (default 3).

        Raises:
            ValueError: If api_key is not provided and CAVENDO_AGENT_KEY is not set.
        """
        self._url = (url or os.environ.get("CAVENDO_URL", "http://localhost:3001")).rstrip("/")
        self._api_key = api_key or os.environ.get("CAVENDO_AGENT_KEY")

        if not self._api_key:
            raise ValueError(
                "API key is required. Provide api_key parameter or set CAVENDO_AGENT_KEY "
                "environment variable."
            )

        self._timeout = timeout
        self._max_retries = max_retries

        # Initialize sync client
        self._sync_client: Optional[httpx.Client] = None

        # Initialize async client
        self._async_client: Optional[httpx.AsyncClient] = None

        # Initialize API modules
        self.tasks = TasksAPI(self)
        self.deliverables = DeliverablesAPI(self)
        self.knowledge = KnowledgeAPI(self)
        self.webhooks = WebhooksAPI(self)

    def _get_sync_client(self) -> httpx.Client:
        """Get or create the synchronous HTTP client."""
        if self._sync_client is None:
            self._sync_client = httpx.Client(
                base_url=self._url,
                timeout=self._timeout,
                headers=self._get_headers(),
            )
        return self._sync_client

    def _get_async_client(self) -> httpx.AsyncClient:
        """Get or create the asynchronous HTTP client."""
        if self._async_client is None:
            self._async_client = httpx.AsyncClient(
                base_url=self._url,
                timeout=self._timeout,
                headers=self._get_headers(),
            )
        return self._async_client

    def _get_headers(self) -> dict[str, str]:
        """
        Get the default headers for API requests.

        Returns:
            Dictionary of HTTP headers with authentication and content type.
        """
        return {
            "X-Agent-Key": self._api_key or "",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def _handle_response_error(self, response: httpx.Response) -> None:
        """
        Handle error responses from the API.

        Args:
            response: The HTTP response to check.

        Raises:
            AuthenticationError: For 401 responses.
            AuthorizationError: For 403 responses.
            NotFoundError: For 404 responses.
            ValidationError: For 400 responses.
            RateLimitError: For 429 responses.
            ServerError: For 5xx responses.
            CavendoError: For other error responses.
        """
        if response.is_success:
            return

        status_code = response.status_code
        try:
            body = response.json()
            message = body.get("error", body.get("message", response.text))
        except Exception:
            body = None
            message = response.text or f"HTTP {status_code}"

        if status_code == 401:
            raise AuthenticationError(message, status_code, body)
        elif status_code == 403:
            raise AuthorizationError(message, status_code, body)
        elif status_code == 404:
            raise NotFoundError(message, status_code, body)
        elif status_code in (400, 422):
            errors = body.get("errors") if body else None
            raise ValidationError(message, status_code, body, errors)
        elif status_code == 429:
            retry_after = None
            if "Retry-After" in response.headers:
                try:
                    retry_after = int(response.headers["Retry-After"])
                except ValueError:
                    pass
            raise RateLimitError(message, status_code, body, retry_after)
        elif 500 <= status_code < 600:
            raise ServerError(message, status_code, body)
        else:
            raise CavendoError(message, status_code, body)

    def _request(
        self,
        method: str,
        path: str,
        params: Optional[dict[str, Any]] = None,
        json: Optional[dict[str, Any]] = None,
    ) -> httpx.Response:
        """
        Make a synchronous HTTP request.

        Args:
            method: HTTP method (GET, POST, PATCH, DELETE).
            path: API path (e.g., /api/agents/me).
            params: Query parameters.
            json: JSON body for POST/PATCH requests.

        Returns:
            The HTTP response.

        Raises:
            ConnectionError: If unable to connect.
            TimeoutError: If the request times out.
            Various CavendoError subclasses for API errors.
        """
        client = self._get_sync_client()

        retries = 0
        last_error: Optional[Exception] = None

        while retries <= self._max_retries:
            try:
                response = client.request(method, path, params=params, json=json)
                self._handle_response_error(response)
                return response
            except (AuthenticationError, AuthorizationError, NotFoundError, ValidationError):
                # Don't retry client errors
                raise
            except RateLimitError as e:
                if retries >= self._max_retries:
                    raise
                # Use retry_after if provided, otherwise exponential backoff
                wait_time = e.retry_after if e.retry_after else (2 ** retries)
                time.sleep(wait_time)
                last_error = e
                retries += 1
            except httpx.ConnectError as e:
                raise CavendoConnectionError(f"Failed to connect to {self._url}: {e}") from e
            except httpx.TimeoutException as e:
                raise CavendoTimeoutError(f"Request timed out: {e}") from e
            except (ServerError, CavendoError) as e:
                if retries >= self._max_retries:
                    raise
                # Exponential backoff for server errors
                wait_time = 2 ** retries
                time.sleep(wait_time)
                last_error = e
                retries += 1

        # Should not reach here, but just in case
        if last_error:
            raise last_error
        raise CavendoError("Request failed after retries")

    async def _request_async(
        self,
        method: str,
        path: str,
        params: Optional[dict[str, Any]] = None,
        json: Optional[dict[str, Any]] = None,
    ) -> httpx.Response:
        """
        Make an asynchronous HTTP request.

        Args:
            method: HTTP method (GET, POST, PATCH, DELETE).
            path: API path (e.g., /api/agents/me).
            params: Query parameters.
            json: JSON body for POST/PATCH requests.

        Returns:
            The HTTP response.

        Raises:
            ConnectionError: If unable to connect.
            TimeoutError: If the request times out.
            Various CavendoError subclasses for API errors.
        """
        client = self._get_async_client()

        retries = 0
        last_error: Optional[Exception] = None

        while retries <= self._max_retries:
            try:
                response = await client.request(method, path, params=params, json=json)
                self._handle_response_error(response)
                return response
            except (AuthenticationError, AuthorizationError, NotFoundError, ValidationError):
                # Don't retry client errors
                raise
            except RateLimitError as e:
                if retries >= self._max_retries:
                    raise
                # Use retry_after if provided, otherwise exponential backoff
                wait_time = e.retry_after if e.retry_after else (2 ** retries)
                await asyncio.sleep(wait_time)
                last_error = e
                retries += 1
            except httpx.ConnectError as e:
                raise CavendoConnectionError(f"Failed to connect to {self._url}: {e}") from e
            except httpx.TimeoutException as e:
                raise CavendoTimeoutError(f"Request timed out: {e}") from e
            except (ServerError, CavendoError) as e:
                if retries >= self._max_retries:
                    raise
                # Exponential backoff for server errors
                wait_time = 2 ** retries
                await asyncio.sleep(wait_time)
                last_error = e
                retries += 1

        if last_error:
            raise last_error
        raise CavendoError("Request failed after retries")

    def _extract_data(self, response: httpx.Response) -> Any:
        """
        Extract data from API response.

        The Cavendo API wraps responses in {success: true, data: ...} format.
        This method extracts the data field or returns the raw response if
        not wrapped.

        Raises:
            ServerError: If the response contains invalid JSON.
        """
        try:
            body = response.json()
        except ValueError as e:
            raise ServerError(f"Invalid JSON response from server: {e}") from e
        if isinstance(body, dict) and "data" in body:
            return body["data"]
        return body

    def _request_json(
        self,
        method: str,
        path: str,
        params: Optional[dict[str, Any]] = None,
        json: Optional[dict[str, Any]] = None,
    ) -> Any:
        """Make a request and return extracted JSON data."""
        response = self._request(method, path, params=params, json=json)
        return self._extract_data(response)

    async def _request_json_async(
        self,
        method: str,
        path: str,
        params: Optional[dict[str, Any]] = None,
        json: Optional[dict[str, Any]] = None,
    ) -> Any:
        """Make an async request and return extracted JSON data."""
        response = await self._request_async(method, path, params=params, json=json)
        return self._extract_data(response)

    def me(self) -> Agent:
        """
        Get information about the current agent.

        Returns:
            Agent object with the current agent's details.

        Example:
            >>> agent = client.me()
            >>> print(f"Agent: {agent.name}")
            >>> print(f"Scopes: {', '.join(agent.scopes)}")
        """
        response = self._request("GET", "/api/agents/me")
        return Agent.from_dict(self._extract_data(response))

    async def me_async(self) -> Agent:
        """
        Async version of me().

        See me() for documentation.
        """
        response = await self._request_async("GET", "/api/agents/me")
        return Agent.from_dict(self._extract_data(response))

    def close(self) -> None:
        """
        Close the client and release resources.

        This should be called when done using the client to properly
        close HTTP connections.
        """
        if self._sync_client:
            self._sync_client.close()
            self._sync_client = None
        # Note: async client should be closed with aclose()

    async def aclose(self) -> None:
        """
        Async version of close().

        This should be called when done using the async client.
        """
        if self._async_client:
            await self._async_client.aclose()
            self._async_client = None

    def __enter__(self) -> "CavendoClient":
        """Context manager entry."""
        return self

    def __exit__(self, *args: Any) -> None:
        """Context manager exit."""
        self.close()

    async def __aenter__(self) -> "CavendoClient":
        """Async context manager entry."""
        return self

    async def __aexit__(self, *args: Any) -> None:
        """Async context manager exit."""
        await self.aclose()
