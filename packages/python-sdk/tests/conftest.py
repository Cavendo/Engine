"""Shared test fixtures for Cavendo SDK tests."""

import pytest
from pytest_httpx import HTTPXMock

from cavendo import CavendoClient


@pytest.fixture
def api_key() -> str:
    """Test API key."""
    return "cav_ak_test_12345"


@pytest.fixture
def base_url() -> str:
    """Test base URL."""
    return "http://localhost:3001"


@pytest.fixture
def client(api_key: str, base_url: str) -> CavendoClient:
    """Create a test client."""
    return CavendoClient(url=base_url, api_key=api_key)


@pytest.fixture
def no_retry_client(api_key: str, base_url: str) -> CavendoClient:
    """Create a test client with no retries (for error handling tests)."""
    return CavendoClient(url=base_url, api_key=api_key, max_retries=0)


@pytest.fixture
def mock_agent_response() -> dict:
    """Mock agent response data."""
    return {
        "success": True,
        "data": {
            "id": 1,
            "name": "Test Agent",
            "type": "autonomous",
            "status": "active",
            "capabilities": ["code", "research"],
            "scopes": ["task:read", "task:write", "deliverable:write"],
            "projectAccess": [1, 2, 3],
            "createdAt": "2025-01-01T00:00:00Z",
            "updatedAt": "2025-01-01T00:00:00Z",
        },
    }


@pytest.fixture
def mock_task_response() -> dict:
    """Mock task response data."""
    return {
        "success": True,
        "data": {
            "id": 123,
            "title": "Test Task",
            "description": "A test task description",
            "status": "pending",
            "priority": 2,
            "projectId": 1,
            "projectName": "Test Project",
            "assignedAgentId": 1,
            "parentTaskId": None,
            "estimatedMinutes": 60,
            "actualMinutes": None,
            "dueDate": "2025-02-01T00:00:00Z",
            "tags": ["test", "example"],
            "metadata": {},
            "createdAt": "2025-01-01T00:00:00Z",
            "updatedAt": "2025-01-01T00:00:00Z",
        },
    }


@pytest.fixture
def mock_deliverable_response() -> dict:
    """Mock deliverable response data."""
    return {
        "success": True,
        "data": {
            "id": 456,
            "taskId": 123,
            "agentId": 1,
            "title": "Test Deliverable",
            "content": "# Test Content",
            "contentType": "markdown",
            "status": "pending",
            "version": 1,
            "feedback": None,
            "metadata": {},
            "createdAt": "2025-01-01T00:00:00Z",
            "updatedAt": "2025-01-01T00:00:00Z",
        },
    }


@pytest.fixture
def mock_knowledge_response() -> dict:
    """Mock knowledge document response data."""
    return {
        "success": True,
        "data": {
            "id": 789,
            "projectId": 1,
            "title": "Test Document",
            "content": "# Test Knowledge",
            "contentType": "markdown",
            "tags": ["test"],
            "metadata": {},
            "createdAt": "2025-01-01T00:00:00Z",
            "updatedAt": "2025-01-01T00:00:00Z",
        },
    }
