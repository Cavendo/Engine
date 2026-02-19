"""
Custom exceptions for the Cavendo SDK.

This module defines all exception types that can be raised by the SDK,
providing clear error handling for API interactions.
"""

from typing import Any, Optional


class CavendoError(Exception):
    """
    Base exception for all Cavendo SDK errors.

    All exceptions raised by the SDK inherit from this class,
    allowing for broad exception handling when needed.

    Attributes:
        message: Human-readable error description.
        status_code: HTTP status code if applicable.
        response_body: Raw response body from the API if available.
    """

    def __init__(
        self,
        message: str,
        status_code: Optional[int] = None,
        response_body: Optional[Any] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.response_body = response_body

    def __str__(self) -> str:
        if self.status_code:
            return f"[{self.status_code}] {self.message}"
        return self.message


class AuthenticationError(CavendoError):
    """
    Raised when authentication fails.

    This occurs when:
    - The API key is missing or invalid
    - The API key has been revoked
    - The agent associated with the key has been deactivated
    """

    def __init__(
        self,
        message: str = "Authentication failed. Check your API key.",
        status_code: int = 401,
        response_body: Optional[Any] = None,
    ) -> None:
        super().__init__(message, status_code, response_body)


class AuthorizationError(CavendoError):
    """
    Raised when the agent lacks required permissions.

    This occurs when attempting an action that requires
    scopes or permissions not granted to the agent.
    """

    def __init__(
        self,
        message: str = "Insufficient permissions for this action.",
        status_code: int = 403,
        response_body: Optional[Any] = None,
    ) -> None:
        super().__init__(message, status_code, response_body)


class NotFoundError(CavendoError):
    """
    Raised when a requested resource is not found.

    This occurs when:
    - The task, deliverable, or knowledge document doesn't exist
    - The resource exists but the agent doesn't have access to it
    """

    def __init__(
        self,
        message: str = "Resource not found.",
        status_code: int = 404,
        response_body: Optional[Any] = None,
    ) -> None:
        super().__init__(message, status_code, response_body)


class ValidationError(CavendoError):
    """
    Raised when request validation fails.

    This occurs when:
    - Required fields are missing
    - Field values are invalid (wrong type, out of range, etc.)
    - Business rules are violated (e.g., invalid status transition)

    Attributes:
        errors: Dictionary mapping field names to error messages.
    """

    def __init__(
        self,
        message: str = "Validation error.",
        status_code: int = 400,
        response_body: Optional[Any] = None,
        errors: Optional[dict[str, list[str]]] = None,
    ) -> None:
        super().__init__(message, status_code, response_body)
        self.errors = errors or {}


class RateLimitError(CavendoError):
    """
    Raised when the API rate limit is exceeded.

    Attributes:
        retry_after: Number of seconds to wait before retrying.
    """

    def __init__(
        self,
        message: str = "Rate limit exceeded.",
        status_code: int = 429,
        response_body: Optional[Any] = None,
        retry_after: Optional[int] = None,
    ) -> None:
        super().__init__(message, status_code, response_body)
        self.retry_after = retry_after


class ServerError(CavendoError):
    """
    Raised when the server returns a 5xx error.

    This indicates an issue on the Cavendo server side.
    """

    def __init__(
        self,
        message: str = "Server error occurred.",
        status_code: int = 500,
        response_body: Optional[Any] = None,
    ) -> None:
        super().__init__(message, status_code, response_body)


class CavendoConnectionError(CavendoError):
    """
    Raised when unable to connect to the Cavendo API.

    This occurs when:
    - The server is unreachable
    - Network issues prevent connection
    - DNS resolution fails
    """

    def __init__(
        self,
        message: str = "Failed to connect to Cavendo API.",
        response_body: Optional[Any] = None,
    ) -> None:
        super().__init__(message, None, response_body)


class CavendoTimeoutError(CavendoError):
    """
    Raised when a request times out.
    """

    def __init__(
        self,
        message: str = "Request timed out.",
        response_body: Optional[Any] = None,
    ) -> None:
        super().__init__(message, None, response_body)


