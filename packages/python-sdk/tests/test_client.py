"""Tests for the CavendoClient class."""

import pytest
from pytest_httpx import HTTPXMock

from cavendo import CavendoClient
from cavendo.exceptions import (
    AuthenticationError,
    CavendoConnectionError,
    NotFoundError,
    ServerError,
    ValidationError,
)


class TestClientInitialization:
    """Tests for client initialization."""

    def test_init_with_explicit_credentials(self) -> None:
        """Test client initialization with explicit credentials."""
        client = CavendoClient(url="http://example.com", api_key="test_key")
        assert client._url == "http://example.com"
        assert client._api_key == "test_key"

    def test_init_removes_trailing_slash(self) -> None:
        """Test that trailing slash is removed from URL."""
        client = CavendoClient(url="http://example.com/", api_key="test_key")
        assert client._url == "http://example.com"

    def test_init_without_api_key_raises_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Test that missing API key raises ValueError."""
        monkeypatch.delenv("CAVENDO_AGENT_KEY", raising=False)
        with pytest.raises(ValueError, match="API key is required"):
            CavendoClient(url="http://example.com")

    def test_init_with_env_variables(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Test client initialization from environment variables."""
        monkeypatch.setenv("CAVENDO_URL", "http://env-url.com")
        monkeypatch.setenv("CAVENDO_AGENT_KEY", "env_key")
        client = CavendoClient()
        assert client._url == "http://env-url.com"
        assert client._api_key == "env_key"


class TestClientMe:
    """Tests for the me() method."""

    def test_me_returns_agent(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_agent_response: dict
    ) -> None:
        """Test that me() returns an Agent object."""
        httpx_mock.add_response(json=mock_agent_response)
        agent = client.me()
        assert agent.id == 1
        assert agent.name == "Test Agent"
        assert agent.type == "autonomous"

    def test_me_handles_auth_error(
        self, client: CavendoClient, httpx_mock: HTTPXMock
    ) -> None:
        """Test that me() raises AuthenticationError on 401."""
        httpx_mock.add_response(
            status_code=401,
            json={"success": False, "error": "Invalid API key"},
        )
        with pytest.raises(AuthenticationError):
            client.me()


class TestClientAsyncMe:
    """Tests for the me_async() method."""

    @pytest.mark.asyncio
    async def test_me_async_returns_agent(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_agent_response: dict
    ) -> None:
        """Test that me_async() returns an Agent object."""
        httpx_mock.add_response(json=mock_agent_response)
        agent = await client.me_async()
        assert agent.id == 1
        assert agent.name == "Test Agent"


class TestClientContextManager:
    """Tests for context manager functionality."""

    def test_sync_context_manager(self, api_key: str, base_url: str) -> None:
        """Test that sync context manager properly closes client."""
        with CavendoClient(url=base_url, api_key=api_key) as client:
            assert client is not None
        # Client should be closed after exiting context

    @pytest.mark.asyncio
    async def test_async_context_manager(self, api_key: str, base_url: str) -> None:
        """Test that async context manager properly closes client."""
        async with CavendoClient(url=base_url, api_key=api_key) as client:
            assert client is not None


class TestErrorHandling:
    """Tests for error handling."""

    def test_not_found_error(
        self, client: CavendoClient, httpx_mock: HTTPXMock
    ) -> None:
        """Test that 404 raises NotFoundError."""
        httpx_mock.add_response(
            status_code=404,
            json={"success": False, "error": "Not found"},
        )
        with pytest.raises(NotFoundError):
            client.me()

    def test_validation_error(
        self, client: CavendoClient, httpx_mock: HTTPXMock
    ) -> None:
        """Test that 400 raises ValidationError."""
        httpx_mock.add_response(
            status_code=400,
            json={"success": False, "error": "Invalid input"},
        )
        with pytest.raises(ValidationError):
            client.me()

    def test_server_error(
        self, no_retry_client: CavendoClient, httpx_mock: HTTPXMock
    ) -> None:
        """Test that 500 raises ServerError (uses no_retry_client to avoid retry logic)."""
        httpx_mock.add_response(
            status_code=500,
            json={"success": False, "error": "Internal error"},
        )
        with pytest.raises(ServerError):
            no_retry_client.me()
