"""
Tasks API for the Cavendo SDK.

This module provides methods for interacting with tasks assigned to the agent.
"""

from typing import TYPE_CHECKING, Any, Optional, Union

from .types import Task, TaskContext, TaskStatus

if TYPE_CHECKING:
    from .client import CavendoClient


class TasksAPI:
    """
    API for managing tasks assigned to the agent.

    This class provides methods to list, retrieve, and update tasks.
    All methods support both synchronous and asynchronous usage.
    """

    def __init__(self, client: "CavendoClient") -> None:
        """
        Initialize the Tasks API.

        Args:
            client: The CavendoClient instance to use for API calls.
        """
        self._client = client

    def list_all(
        self,
        status: Optional[Union[str, TaskStatus]] = None,
        project_id: Optional[int] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[Task]:
        """
        List tasks assigned to the current agent.

        Args:
            status: Filter by task status (pending, assigned, in_progress, review, completed, cancelled).
            project_id: Filter by project ID.
            limit: Maximum number of tasks to return (default 50).
            offset: Number of tasks to skip for pagination.

        Returns:
            List of Task objects.

        Example:
            >>> tasks = client.tasks.list_all(status="pending")
            >>> for task in tasks:
            ...     print(f"{task.id}: {task.title}")
        """
        params: dict[str, Any] = {"limit": limit, "offset": offset}
        if status:
            params["status"] = status.value if isinstance(status, TaskStatus) else status
        if project_id:
            params["projectId"] = project_id

        data = self._client._request_json("GET", "/api/agents/me/tasks", params=params)

        # Handle both array and paginated response formats
        tasks_data = data if isinstance(data, list) else data.get("tasks", [])
        return [Task.from_dict(t) for t in tasks_data]

    async def list_all_async(
        self,
        status: Optional[Union[str, TaskStatus]] = None,
        project_id: Optional[int] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[Task]:
        """
        Async version of list_all().

        See list_all() for documentation.
        """
        params: dict[str, Any] = {"limit": limit, "offset": offset}
        if status:
            params["status"] = status.value if isinstance(status, TaskStatus) else status
        if project_id:
            params["projectId"] = project_id

        data = await self._client._request_json_async("GET", "/api/agents/me/tasks", params=params)

        tasks_data = data if isinstance(data, list) else data.get("tasks", [])
        return [Task.from_dict(t) for t in tasks_data]

    def next(self) -> Optional[Task]:
        """
        Get the next task to work on.

        Returns the highest priority pending task assigned to this agent.

        Returns:
            The next Task to work on, or None if no tasks are available.

        Example:
            >>> task = client.tasks.next()
            >>> if task:
            ...     print(f"Next task: {task.title}")
            ...     client.tasks.update_status(task.id, "in_progress")
        """
        data = self._client._request_json("GET", "/api/agents/me/tasks/next")

        if not data or (isinstance(data, dict) and not data.get("task")):
            return None

        # API returns {task: ...} or {task: null, reason: ...}
        task_data = data.get("task") if isinstance(data, dict) else data
        return Task.from_dict(task_data) if task_data else None

    async def next_async(self) -> Optional[Task]:
        """
        Async version of next().

        See next() for documentation.
        """
        data = await self._client._request_json_async("GET", "/api/agents/me/tasks/next")

        if not data or (isinstance(data, dict) and not data.get("task")):
            return None

        task_data = data.get("task") if isinstance(data, dict) else data
        return Task.from_dict(task_data) if task_data else None

    def get(self, task_id: int) -> Task:
        """
        Get a specific task by ID.

        Args:
            task_id: The task ID to retrieve.

        Returns:
            The requested Task.

        Raises:
            NotFoundError: If the task doesn't exist or isn't accessible.

        Example:
            >>> task = client.tasks.get(123)
            >>> print(task.description)
        """
        data = self._client._request_json("GET", f"/api/tasks/{task_id}")
        return Task.from_dict(data)

    async def get_async(self, task_id: int) -> Task:
        """
        Async version of get().

        See get() for documentation.
        """
        data = await self._client._request_json_async("GET", f"/api/tasks/{task_id}")
        return Task.from_dict(data)

    def context(self, task_id: int) -> TaskContext:
        """
        Get the full context for a task.

        This includes the task itself, project details, related tasks,
        relevant knowledge documents, and previous deliverables.

        Args:
            task_id: The task ID to get context for.

        Returns:
            TaskContext with all related information.

        Example:
            >>> context = client.tasks.context(123)
            >>> print(f"Project: {context.project['name']}")
            >>> for doc in context.knowledge:
            ...     print(f"Reference: {doc.title}")
        """
        data = self._client._request_json("GET", f"/api/tasks/{task_id}/context")
        return TaskContext.from_dict(data)

    async def context_async(self, task_id: int) -> TaskContext:
        """
        Async version of context().

        See context() for documentation.
        """
        data = await self._client._request_json_async("GET", f"/api/tasks/{task_id}/context")
        return TaskContext.from_dict(data)

    def update_status(
        self,
        task_id: int,
        status: Union[str, TaskStatus],
        progress: Optional[dict[str, Any]] = None,
    ) -> Task:
        """
        Update the status of a task.

        Args:
            task_id: The task ID to update.
            status: New status (in_progress, review). Note: completed/cancelled are set by the system.
            progress: Optional progress metadata (e.g., {"step": 3, "total_steps": 5}).

        Returns:
            The updated Task.

        Raises:
            ValidationError: If the status transition is invalid.
            NotFoundError: If the task doesn't exist.

        Example:
            >>> # Start working on a task
            >>> client.tasks.update_status(123, "in_progress")

            >>> # Mark task ready for review with progress info
            >>> client.tasks.update_status(
            ...     123,
            ...     "review",
            ...     progress={"completed_steps": ["research", "draft", "edit"]}
            ... )
        """
        body: dict[str, Any] = {
            "status": status.value if isinstance(status, TaskStatus) else status
        }
        if progress is not None:
            body["progress"] = progress

        data = self._client._request_json("PATCH", f"/api/tasks/{task_id}/status", json=body)
        return Task.from_dict(data)

    async def update_status_async(
        self,
        task_id: int,
        status: Union[str, TaskStatus],
        progress: Optional[dict[str, Any]] = None,
    ) -> Task:
        """
        Async version of update_status().

        See update_status() for documentation.
        """
        body: dict[str, Any] = {
            "status": status.value if isinstance(status, TaskStatus) else status
        }
        if progress is not None:
            body["progress"] = progress

        data = await self._client._request_json_async(
            "PATCH", f"/api/tasks/{task_id}/status", json=body
        )
        return Task.from_dict(data)

    def claim(self, task_id: int) -> Task:
        """
        Claim an unassigned task for this agent.

        The task must be in 'pending' status and not assigned to another agent.
        After claiming, the task status changes to 'assigned' and is linked to
        this agent.

        Args:
            task_id: The ID of the task to claim.

        Returns:
            The claimed Task.

        Raises:
            ConflictError: If the task is already claimed by another agent.
            NotFoundError: If the task doesn't exist.

        Example:
            >>> task = client.tasks.next()
            >>> if task:
            ...     claimed = client.tasks.claim(task.id)
            ...     print(f"Claimed: {claimed.title}")
            ...     context = client.tasks.context(claimed.id)
        """
        data = self._client._request_json("POST", f"/api/tasks/{task_id}/claim")
        return Task.from_dict(data)

    async def claim_async(self, task_id: int) -> Task:
        """
        Async version of claim().

        See claim() for documentation.
        """
        data = await self._client._request_json_async("POST", f"/api/tasks/{task_id}/claim")
        return Task.from_dict(data)

    def log_progress(
        self,
        task_id: int,
        message: str,
        percent_complete: Optional[int] = None,
        details: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """
        Log a progress update for a task.

        Use this to report incremental progress on long-running tasks.
        Progress updates are visible to reviewers and help track task execution.

        Args:
            task_id: The ID of the task to log progress for.
            message: A description of the progress made.
            percent_complete: Optional completion percentage (0-100).
            details: Optional additional metadata about the progress.

        Returns:
            The created progress log entry.

        Example:
            >>> client.tasks.log_progress(123, "Research phase complete", percent_complete=30)
            >>> client.tasks.log_progress(123, "Draft written", percent_complete=70)
            >>> client.tasks.log_progress(
            ...     123,
            ...     "Final review",
            ...     percent_complete=90,
            ...     details={"sections_complete": ["intro", "body", "conclusion"]}
            ... )
        """
        body: dict[str, Any] = {"message": message}
        if percent_complete is not None:
            body["percentComplete"] = percent_complete
        if details is not None:
            body["details"] = details

        return self._client._request_json("POST", f"/api/tasks/{task_id}/progress", json=body)

    async def log_progress_async(
        self,
        task_id: int,
        message: str,
        percent_complete: Optional[int] = None,
        details: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """
        Async version of log_progress().

        See log_progress() for documentation.
        """
        body: dict[str, Any] = {"message": message}
        if percent_complete is not None:
            body["percentComplete"] = percent_complete
        if details is not None:
            body["details"] = details

        return await self._client._request_json_async(
            "POST", f"/api/tasks/{task_id}/progress", json=body
        )
