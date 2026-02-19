"""Tests for the KnowledgeAPI class."""

import pytest
from pytest_httpx import HTTPXMock

from cavendo import CavendoClient
from cavendo.types import KnowledgeDocument, SearchResult


class TestKnowledgeSearch:
    """Tests for knowledge.search() method."""

    def test_search_returns_results(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_knowledge_response: dict
    ) -> None:
        """Test that search() returns a list of SearchResult objects."""
        search_result = {
            "document": mock_knowledge_response["data"],
            "score": 0.95,
            "highlights": ["...matching text..."],
        }
        httpx_mock.add_response(
            json={"success": True, "data": [search_result]}
        )
        results = client.knowledge.search("test query")
        assert len(results) == 1
        assert isinstance(results[0], SearchResult)
        assert results[0].score == 0.95

    def test_search_with_filters(
        self, client: CavendoClient, httpx_mock: HTTPXMock
    ) -> None:
        """Test search() with project_id and tags filters."""
        httpx_mock.add_response(json={"success": True, "data": []})
        client.knowledge.search("query", project_id=1, tags=["test", "docs"])
        request = httpx_mock.get_request()
        assert request is not None
        assert "q=query" in str(request.url)
        assert "projectId=1" in str(request.url)
        assert "tags=test%2Cdocs" in str(request.url) or "tags=test,docs" in str(request.url)


class TestKnowledgeGet:
    """Tests for knowledge.get() method."""

    def test_get_returns_document(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_knowledge_response: dict
    ) -> None:
        """Test that get() returns a KnowledgeDocument object."""
        httpx_mock.add_response(json=mock_knowledge_response)
        doc = client.knowledge.get(789)
        assert isinstance(doc, KnowledgeDocument)
        assert doc.id == 789
        assert doc.title == "Test Document"


class TestKnowledgeListAll:
    """Tests for knowledge.list_all() method."""

    def test_list_all_returns_documents(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_knowledge_response: dict
    ) -> None:
        """Test that list_all() returns a list of KnowledgeDocument objects."""
        httpx_mock.add_response(
            json={"success": True, "data": [mock_knowledge_response["data"]]}
        )
        docs = client.knowledge.list_all()
        assert len(docs) == 1
        assert isinstance(docs[0], KnowledgeDocument)

    def test_list_all_with_filters(
        self, client: CavendoClient, httpx_mock: HTTPXMock
    ) -> None:
        """Test list_all() with project_id and pagination."""
        httpx_mock.add_response(json={"success": True, "data": []})
        client.knowledge.list_all(project_id=1, limit=10, offset=20)
        request = httpx_mock.get_request()
        assert request is not None
        assert "projectId=1" in str(request.url)
        assert "limit=10" in str(request.url)
        assert "offset=20" in str(request.url)

    def test_list_all_handles_array_response(
        self, client: CavendoClient, httpx_mock: HTTPXMock, mock_knowledge_response: dict
    ) -> None:
        """Test list_all() handles direct array response."""
        httpx_mock.add_response(json=[mock_knowledge_response["data"]])
        docs = client.knowledge.list_all()
        assert len(docs) == 1
