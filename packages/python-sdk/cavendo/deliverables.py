"""
Deliverables API for the Cavendo SDK.

This module provides methods for submitting and managing deliverables.
"""

from typing import TYPE_CHECKING, Any, List, Optional, Union

from .types import ActionItem, ContentType, Deliverable, DeliverableStatus, Feedback, FileAttachment

if TYPE_CHECKING:
    from .client import CavendoClient


class DeliverablesAPI:
    """
    API for managing deliverables submitted by the agent.

    This class provides methods to submit deliverables, get feedback,
    and submit revisions. All methods support both synchronous and
    asynchronous usage.
    """

    def __init__(self, client: "CavendoClient") -> None:
        """
        Initialize the Deliverables API.

        Args:
            client: The CavendoClient instance to use for API calls.
        """
        self._client = client

    def submit(
        self,
        title: str,
        task_id: Optional[int] = None,
        project_id: Optional[Union[int, str]] = None,
        content: Optional[str] = None,
        content_type: Union[str, ContentType] = ContentType.MARKDOWN,
        metadata: Optional[dict[str, Any]] = None,
        summary: Optional[str] = None,
        files: Optional[List[FileAttachment]] = None,
        actions: Optional[List[ActionItem]] = None,
        input_tokens: Optional[int] = None,
        output_tokens: Optional[int] = None,
        provider: Optional[str] = None,
        model: Optional[str] = None,
    ) -> Deliverable:
        """
        Submit a new deliverable.

        Either ``task_id`` or ``project_id`` (or both) should be provided.
        Omit ``task_id`` for standalone (project-level) deliverables.

        IMPORTANT: For HTML, JSX, CSS, JS, or any code files, use the `files`
        parameter to attach them - do NOT put code in `content`. Use `summary`
        to describe what was created (shown in Overview tab).

        Args:
            title: Title of the deliverable.
            task_id: Optional task ID (omit for standalone deliverables).
            project_id: Optional project name or ID for standalone deliverables.
            content: Optional plain text/markdown content. DO NOT use for
                HTML/code - use `files` instead.
            content_type: Type of content (markdown, html, json, text, code).
            metadata: Optional metadata (e.g., sources, references).
            summary: Text description of the work completed (markdown supported).
                This is shown in the Overview tab. For code deliverables, describe
                what was built and any key decisions made.
            files: Array of file attachments (HTML, JSX, CSS, JS, etc.).
                Each file dict should have:
                - filename: Filename with extension (e.g., "landing-page.html")
                - content: The complete file content. For binary files, prefix with "base64:".
                - mimeType: Optional MIME type. Auto-detected from extension if not provided.
            actions: Follow-up action items for the reviewer to complete.
                Each action dict should have:
                - action_text: The action item (e.g., "Review the landing page copy")
                - estimated_time_minutes: Optional estimated time in minutes (default: 25)
                - notes: Optional additional context or instructions

        Returns:
            The created Deliverable.

        Raises:
            ValidationError: If required fields are missing or invalid.
            NotFoundError: If the task doesn't exist.

        Example:
            >>> # Simple text deliverable
            >>> deliverable = client.deliverables.submit(
            ...     task_id=123,
            ...     title="Research Report",
            ...     content="## Findings\\n\\n...",
            ...     content_type="markdown",
            ...     metadata={"sources": ["https://example.com"]}
            ... )
            >>> print(f"Submitted deliverable {deliverable.id}")

            >>> # Code deliverable with files
            >>> deliverable = client.deliverables.submit(
            ...     task_id=456,
            ...     title="Landing Page",
            ...     summary="Created a responsive landing page with hero section.",
            ...     files=[
            ...         {"filename": "index.html", "content": "<html>...</html>"},
            ...         {"filename": "styles.css", "content": "body { ... }"},
            ...     ],
            ...     actions=[
            ...         {"action_text": "Review copy for brand voice", "estimated_time_minutes": 10},
            ...         {"action_text": "Test on mobile devices"},
            ...     ]
            ... )
        """
        body: dict[str, Any] = {
            "title": title,
            "contentType": (
                content_type.value if isinstance(content_type, ContentType) else content_type
            ),
        }
        if task_id is not None:
            body["taskId"] = task_id
        if project_id is not None:
            body["projectId"] = project_id
        if content is not None:
            body["content"] = content
        if metadata is not None:
            body["metadata"] = metadata
        if summary is not None:
            body["summary"] = summary
        if files is not None:
            body["files"] = files
        if actions is not None:
            body["actions"] = actions
        if input_tokens is not None:
            body["input_tokens"] = input_tokens
        if output_tokens is not None:
            body["output_tokens"] = output_tokens
        if provider is not None:
            body["provider"] = provider
        if model is not None:
            body["model"] = model

        data = self._client._request_json("POST", "/api/deliverables", json=body)
        return Deliverable.from_dict(data)

    async def submit_async(
        self,
        title: str,
        task_id: Optional[int] = None,
        project_id: Optional[Union[int, str]] = None,
        content: Optional[str] = None,
        content_type: Union[str, ContentType] = ContentType.MARKDOWN,
        metadata: Optional[dict[str, Any]] = None,
        summary: Optional[str] = None,
        files: Optional[List[FileAttachment]] = None,
        actions: Optional[List[ActionItem]] = None,
        input_tokens: Optional[int] = None,
        output_tokens: Optional[int] = None,
        provider: Optional[str] = None,
        model: Optional[str] = None,
    ) -> Deliverable:
        """
        Async version of submit().

        See submit() for documentation.
        """
        body: dict[str, Any] = {
            "title": title,
            "contentType": (
                content_type.value if isinstance(content_type, ContentType) else content_type
            ),
        }
        if task_id is not None:
            body["taskId"] = task_id
        if project_id is not None:
            body["projectId"] = project_id
        if content is not None:
            body["content"] = content
        if metadata is not None:
            body["metadata"] = metadata
        if summary is not None:
            body["summary"] = summary
        if files is not None:
            body["files"] = files
        if actions is not None:
            body["actions"] = actions
        if input_tokens is not None:
            body["input_tokens"] = input_tokens
        if output_tokens is not None:
            body["output_tokens"] = output_tokens
        if provider is not None:
            body["provider"] = provider
        if model is not None:
            body["model"] = model

        data = await self._client._request_json_async("POST", "/api/deliverables", json=body)
        return Deliverable.from_dict(data)

    def get(self, deliverable_id: int) -> Deliverable:
        """
        Get a specific deliverable by ID.

        Args:
            deliverable_id: The deliverable ID to retrieve.

        Returns:
            The requested Deliverable.

        Raises:
            NotFoundError: If the deliverable doesn't exist.

        Example:
            >>> deliverable = client.deliverables.get(456)
            >>> print(deliverable.content)
        """
        data = self._client._request_json("GET", f"/api/deliverables/{deliverable_id}")
        return Deliverable.from_dict(data)

    async def get_async(self, deliverable_id: int) -> Deliverable:
        """
        Async version of get().

        See get() for documentation.
        """
        data = await self._client._request_json_async("GET", f"/api/deliverables/{deliverable_id}")
        return Deliverable.from_dict(data)

    def get_feedback(self, deliverable_id: int) -> Optional[Feedback]:
        """
        Get feedback for a deliverable.

        Args:
            deliverable_id: The deliverable ID to get feedback for.

        Returns:
            Feedback if available, None otherwise.

        Example:
            >>> feedback = client.deliverables.get_feedback(456)
            >>> if feedback:
            ...     if feedback.status == "revision_requested":
            ...         print(f"Revision needed: {feedback.content}")
        """
        data = self._client._request_json("GET", f"/api/deliverables/{deliverable_id}/feedback")

        if not data or (isinstance(data, dict) and not data.get("feedback")):
            return None

        # API returns {id, status, feedback, reviewedBy, reviewedAt}
        return Feedback.from_dict(data)

    async def get_feedback_async(self, deliverable_id: int) -> Optional[Feedback]:
        """
        Async version of get_feedback().

        See get_feedback() for documentation.
        """
        data = await self._client._request_json_async(
            "GET", f"/api/deliverables/{deliverable_id}/feedback"
        )

        if not data or (isinstance(data, dict) and not data.get("feedback")):
            return None

        return Feedback.from_dict(data)

    def submit_revision(
        self,
        deliverable_id: int,
        content: Optional[str] = None,
        title: Optional[str] = None,
        content_type: Optional[Union[str, ContentType]] = None,
        metadata: Optional[dict[str, Any]] = None,
        summary: Optional[str] = None,
        files: Optional[List[FileAttachment]] = None,
    ) -> Deliverable:
        """
        Submit a revision for a deliverable.

        This creates a new version of the deliverable with updated content.

        IMPORTANT: For HTML, JSX, CSS, JS, or code file revisions, use the
        `files` parameter instead of `content`.

        Args:
            deliverable_id: The deliverable ID to revise.
            content: The revised content (for text/markdown). DO NOT use for
                HTML/code - use `files` instead.
            title: Optional new title (keeps original if not provided).
            content_type: Optional new content type.
            metadata: Optional updated metadata.
            summary: Text description of the revision changes (shown in Overview tab).
                For code deliverables, describe what was changed.
            files: Array of file attachments (HTML, JSX, CSS, JS, etc.).
                Each file dict should have:
                - filename: Filename with extension (e.g., "landing-page.html")
                - content: The complete file content. For binary files, prefix with "base64:".
                - mimeType: Optional MIME type. Auto-detected from extension if not provided.

        Returns:
            The updated Deliverable with incremented version.

        Raises:
            ValidationError: If neither content, summary, nor files is provided.
            NotFoundError: If the deliverable doesn't exist.

        Example:
            >>> # Get feedback and submit text revision
            >>> feedback = client.deliverables.get_feedback(456)
            >>> if feedback and feedback.status == "revision_requested":
            ...     revised = client.deliverables.submit_revision(
            ...         deliverable_id=456,
            ...         content="## Updated Findings\\n\\n..."
            ...     )
            ...     print(f"Submitted revision v{revised.version}")

            >>> # Submit code revision with updated files
            >>> revised = client.deliverables.submit_revision(
            ...     deliverable_id=789,
            ...     summary="Updated hero section per feedback.",
            ...     files=[
            ...         {"filename": "index.html", "content": "<html>...</html>"},
            ...     ]
            ... )
        """
        body: dict[str, Any] = {}
        if content is not None:
            body["content"] = content
        if title is not None:
            body["title"] = title
        if content_type is not None:
            body["contentType"] = (
                content_type.value if isinstance(content_type, ContentType) else content_type
            )
        if metadata is not None:
            body["metadata"] = metadata
        if summary is not None:
            body["summary"] = summary
        if files is not None:
            body["files"] = files

        data = self._client._request_json(
            "POST", f"/api/deliverables/{deliverable_id}/revision", json=body
        )
        return Deliverable.from_dict(data)

    async def submit_revision_async(
        self,
        deliverable_id: int,
        content: Optional[str] = None,
        title: Optional[str] = None,
        content_type: Optional[Union[str, ContentType]] = None,
        metadata: Optional[dict[str, Any]] = None,
        summary: Optional[str] = None,
        files: Optional[List[FileAttachment]] = None,
    ) -> Deliverable:
        """
        Async version of submit_revision().

        See submit_revision() for documentation.
        """
        body: dict[str, Any] = {}
        if content is not None:
            body["content"] = content
        if title is not None:
            body["title"] = title
        if content_type is not None:
            body["contentType"] = (
                content_type.value if isinstance(content_type, ContentType) else content_type
            )
        if metadata is not None:
            body["metadata"] = metadata
        if summary is not None:
            body["summary"] = summary
        if files is not None:
            body["files"] = files

        data = await self._client._request_json_async(
            "POST", f"/api/deliverables/{deliverable_id}/revision", json=body
        )
        return Deliverable.from_dict(data)

    def mine(
        self,
        status: Optional[Union[str, DeliverableStatus]] = None,
        task_id: Optional[int] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[Deliverable]:
        """
        List deliverables submitted by the current agent.

        Args:
            status: Filter by deliverable status.
            task_id: Filter by task ID.
            limit: Maximum number of deliverables to return.
            offset: Number of deliverables to skip for pagination.

        Returns:
            List of Deliverable objects.

        Example:
            >>> # Get all pending deliverables
            >>> pending = client.deliverables.mine(status="pending")

            >>> # Get deliverables needing revision
            >>> to_revise = client.deliverables.mine(status="revision_requested")
        """
        params: dict[str, Any] = {"limit": limit, "offset": offset}
        if status:
            params["status"] = (
                status.value if isinstance(status, DeliverableStatus) else status
            )
        if task_id:
            params["taskId"] = task_id

        data = self._client._request_json("GET", "/api/deliverables/mine", params=params)

        deliverables_data = data if isinstance(data, list) else data.get("deliverables", [])
        return [Deliverable.from_dict(d) for d in deliverables_data]

    async def mine_async(
        self,
        status: Optional[Union[str, DeliverableStatus]] = None,
        task_id: Optional[int] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[Deliverable]:
        """
        Async version of mine().

        See mine() for documentation.
        """
        params: dict[str, Any] = {"limit": limit, "offset": offset}
        if status:
            params["status"] = (
                status.value if isinstance(status, DeliverableStatus) else status
            )
        if task_id:
            params["taskId"] = task_id

        data = await self._client._request_json_async(
            "GET", "/api/deliverables/mine", params=params
        )

        deliverables_data = data if isinstance(data, list) else data.get("deliverables", [])
        return [Deliverable.from_dict(d) for d in deliverables_data]
