"""
Knowledge API for the Cavendo SDK.

This module provides methods for searching and retrieving knowledge documents.
"""

from typing import TYPE_CHECKING, Any, Optional

from .types import KnowledgeDocument, SearchResult

if TYPE_CHECKING:
    from .client import CavendoClient


class KnowledgeAPI:
    """
    API for accessing the knowledge base.

    This class provides methods to search and retrieve knowledge documents
    that can inform task completion. All methods support both synchronous
    and asynchronous usage.
    """

    def __init__(self, client: "CavendoClient") -> None:
        """
        Initialize the Knowledge API.

        Args:
            client: The CavendoClient instance to use for API calls.
        """
        self._client = client

    def search(
        self,
        query: str,
        project_id: Optional[int] = None,
        tags: Optional[list[str]] = None,
        limit: int = 10,
    ) -> list[SearchResult]:
        """
        Search the knowledge base.

        Args:
            query: Search query string.
            project_id: Optional project ID to scope the search.
            tags: Optional list of tags to filter by.
            limit: Maximum number of results to return (default 10).

        Returns:
            List of SearchResult objects with matching documents.

        Example:
            >>> results = client.knowledge.search(
            ...     query="pricing strategy",
            ...     project_id=3
            ... )
            >>> for result in results:
            ...     print(f"{result.document.title} (score: {result.score})")
            ...     for highlight in result.highlights:
            ...         print(f"  - {highlight}")
        """
        params: dict[str, Any] = {"q": query, "limit": limit}
        if project_id is not None:
            params["projectId"] = project_id
        if tags:
            params["tags"] = ",".join(tags)

        data = self._client._request_json("GET", "/api/knowledge/search", params=params)

        results_data = data if isinstance(data, list) else data.get("results", [])
        return [SearchResult.from_dict(r) for r in results_data]

    async def search_async(
        self,
        query: str,
        project_id: Optional[int] = None,
        tags: Optional[list[str]] = None,
        limit: int = 10,
    ) -> list[SearchResult]:
        """
        Async version of search().

        See search() for documentation.
        """
        params: dict[str, Any] = {"q": query, "limit": limit}
        if project_id is not None:
            params["projectId"] = project_id
        if tags:
            params["tags"] = ",".join(tags)

        data = await self._client._request_json_async("GET", "/api/knowledge/search", params=params)

        results_data = data if isinstance(data, list) else data.get("results", [])
        return [SearchResult.from_dict(r) for r in results_data]

    def get(self, knowledge_id: int) -> KnowledgeDocument:
        """
        Get a specific knowledge document by ID.

        Args:
            knowledge_id: The knowledge document ID to retrieve.

        Returns:
            The requested KnowledgeDocument.

        Raises:
            NotFoundError: If the document doesn't exist.

        Example:
            >>> doc = client.knowledge.get(5)
            >>> print(doc.content)
        """
        data = self._client._request_json("GET", f"/api/knowledge/{knowledge_id}")
        return KnowledgeDocument.from_dict(data)

    async def get_async(self, knowledge_id: int) -> KnowledgeDocument:
        """
        Async version of get().

        See get() for documentation.
        """
        data = await self._client._request_json_async("GET", f"/api/knowledge/{knowledge_id}")
        return KnowledgeDocument.from_dict(data)

    def list_all(
        self,
        project_id: Optional[int] = None,
        tags: Optional[list[str]] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[KnowledgeDocument]:
        """
        List knowledge documents.

        Args:
            project_id: Optional project ID to filter by.
            tags: Optional list of tags to filter by.
            limit: Maximum number of documents to return.
            offset: Number of documents to skip for pagination.

        Returns:
            List of KnowledgeDocument objects.

        Example:
            >>> docs = client.knowledge.list_all(project_id=3)
            >>> for doc in docs:
            ...     print(f"{doc.id}: {doc.title}")
        """
        params: dict[str, Any] = {"limit": limit, "offset": offset}
        if project_id is not None:
            params["projectId"] = project_id
        if tags:
            params["tags"] = ",".join(tags)

        data = self._client._request_json("GET", "/api/knowledge", params=params)

        docs_data = data if isinstance(data, list) else data.get("documents", [])
        return [KnowledgeDocument.from_dict(d) for d in docs_data]

    async def list_all_async(
        self,
        project_id: Optional[int] = None,
        tags: Optional[list[str]] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[KnowledgeDocument]:
        """
        Async version of list_all().

        See list_all() for documentation.
        """
        params: dict[str, Any] = {"limit": limit, "offset": offset}
        if project_id is not None:
            params["projectId"] = project_id
        if tags:
            params["tags"] = ",".join(tags)

        data = await self._client._request_json_async("GET", "/api/knowledge", params=params)

        docs_data = data if isinstance(data, list) else data.get("documents", [])
        return [KnowledgeDocument.from_dict(d) for d in docs_data]
