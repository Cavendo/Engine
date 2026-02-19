"""Tests for the TasksAPI class."""

import pytest
from pytest_httpx import HTTPXMock

from cavendo import CavendoClient
from cavendo.types import Task, TaskContext


class TestTasksListAll:
    """Tests for tasks.list_all() method."""

    def test_list_all_returns_tasks(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_task_response: dict
    ) -> None:
        """Test that list_all() returns a list of Task objects."""
        httpx_mock.add_response(
            json={"success": True, "data": [mock_task_response["data"]]}
        )
        tasks = client.tasks.list_all()
        assert len(tasks) == 1
        assert isinstance(tasks[0], Task)
        assert tasks[0].id == 123

    def test_list_all_with_filters(
        self, client: CavendoClient, httpx_mock: HTTPXMock
    ) -> None:
        """Test list_all() with status and project_id filters."""
        httpx_mock.add_response(json={"success": True, "data": []})
        client.tasks.list_all(status="pending", project_id=1, limit=10)
        request = httpx_mock.get_request()
        assert request is not None
        assert "status=pending" in str(request.url)
        assert "projectId=1" in str(request.url)
        assert "limit=10" in str(request.url)

    def test_list_all_handles_array_response(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_task_response: dict
    ) -> None:
        """Test list_all() handles direct array response."""
        httpx_mock.add_response(json=[mock_task_response["data"]])
        tasks = client.tasks.list_all()
        assert len(tasks) == 1


class TestTasksNext:
    """Tests for tasks.next() method."""

    def test_next_returns_task(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_task_response: dict
    ) -> None:
        """Test that next() returns a Task object."""
        httpx_mock.add_response(
            json={"success": True, "data": {"task": mock_task_response["data"]}}
        )
        task = client.tasks.next()
        assert task is not None
        assert isinstance(task, Task)
        assert task.id == 123

    def test_next_returns_none_when_empty(
        self, client: CavendoClient, httpx_mock: HTTPXMock
    ) -> None:
        """Test that next() returns None when no tasks available."""
        httpx_mock.add_response(
            json={"success": True, "data": {"task": None, "reason": "No pending tasks"}}
        )
        task = client.tasks.next()
        assert task is None


class TestTasksGet:
    """Tests for tasks.get() method."""

    def test_get_returns_task(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_task_response: dict
    ) -> None:
        """Test that get() returns a Task object."""
        httpx_mock.add_response(json=mock_task_response)
        task = client.tasks.get(123)
        assert isinstance(task, Task)
        assert task.id == 123
        assert task.title == "Test Task"


class TestTasksContext:
    """Tests for tasks.context() method."""

    def test_context_returns_task_context(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_task_response: dict
    ) -> None:
        """Test that context() returns a TaskContext object."""
        context_data = {
            "success": True,
            "data": {
                "task": mock_task_response["data"],
                "project": {
                    "id": 1,
                    "name": "Test Project",
                    "description": "A test project",
                    "type": "development",
                },
                "knowledge": [],
                "relatedTasks": [],
                "deliverables": [],
            },
        }
        httpx_mock.add_response(json=context_data)
        context = client.tasks.context(123)
        assert isinstance(context, TaskContext)
        assert context.task.id == 123
        assert context.project["name"] == "Test Project"


class TestTasksUpdateStatus:
    """Tests for tasks.update_status() method."""

    def test_update_status_returns_updated_task(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_task_response: dict
    ) -> None:
        """Test that update_status() returns the updated task."""
        updated = mock_task_response.copy()
        updated["data"]["status"] = "in_progress"
        httpx_mock.add_response(json=updated)
        task = client.tasks.update_status(123, "in_progress")
        assert task.status == "in_progress"

    def test_update_status_with_progress(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_task_response: dict
    ) -> None:
        """Test update_status() with progress metadata."""
        httpx_mock.add_response(json=mock_task_response)
        client.tasks.update_status(123, "in_progress", progress={"step": 1, "total": 5})
        request = httpx_mock.get_request()
        assert request is not None
        # Verify progress was sent in request body
