"""UltraContext API client."""

import asyncio
import datetime
import email.utils
import random
import time
from typing import Any, Dict, List, Optional, Union, overload
from urllib.parse import quote

import httpx

from .exceptions import UltraContextHttpError
from .types import (
    AppendResponse,
    CreateContextResponse,
    DeleteManyResponse,
    DeleteResponse,
    GetContextResponse,
    ListContextsResponse,
    PermanentDeleteResponse,
    UpdateResponse,
)

# -- retry policy (SDK-001) ------------------------------------------------------
# Statuses worth retrying:
#   - 429: safe for EVERY method — the API's rate-limit gate rejects the
#     request before any handler runs, so nothing was processed.
#   - 5xx: only for idempotent methods. Blindly retrying a POST /contexts/:id
#     (append) after a server error could double-apply the write if the server
#     actually processed it.
# 409 is deliberately NOT retried: the API's conflict + Retry-After is
# surfaced to the caller, who decides whether the operation is safe to retry
# verbatim.
_RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})
_IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "PUT", "DELETE"})

DEFAULT_MAX_RETRIES = 3
_BACKOFF_BASE = 0.5
_BACKOFF_CAP = 8.0


def backoff_delay(attempt: int, *, base: float = _BACKOFF_BASE, cap: float = _BACKOFF_CAP) -> float:
    """Exponential backoff with jitter (half..full of the computed delay).

    ``attempt`` is 0-based: 0.5s → 1s → 2s → 4s, capped at ``cap``.
    """
    delay = min(cap, base * (2 ** attempt))
    return random.uniform(delay / 2, delay)


def _retry_after_seconds(response: httpx.Response) -> Optional[float]:
    """Honour the server's Retry-After (header: seconds or HTTP-date).

    The API's 429 rate-limit additionally carries ``retry_after_sec`` in the
    JSON body (the header is not guaranteed there) — used as a fallback.
    """
    header = response.headers.get("retry-after")
    if header:
        header = header.strip()
        try:
            return max(0.0, float(header))
        except ValueError:
            try:
                dt = email.utils.parsedate_to_datetime(header)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=datetime.timezone.utc)
                delta = (dt - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
                return max(0.0, delta)
            except (TypeError, ValueError):
                return None
    if response.status_code == 429:
        try:
            body = response.json()
        except ValueError:
            body = None
        if isinstance(body, dict):
            value = body.get("retry_after_sec")
            if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
                return float(value)
    return None



class _BaseClient:
    """Base client with shared config."""

    DEFAULT_BASE_URL = "https://api.ultracontext.ai"
    DEFAULT_TIMEOUT = 30.0

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        base_url: Optional[str] = None,
        timeout: Optional[float] = None,
        headers: Optional[Dict[str, str]] = None,
        max_retries: int = DEFAULT_MAX_RETRIES,
    ):
        self._api_key = api_key
        self._base_url = (base_url or self.DEFAULT_BASE_URL).rstrip("/")
        self._timeout = timeout or self.DEFAULT_TIMEOUT
        self._headers = headers or {}
        # SDK-001 resilience: retries for transient failures (429/5xx) with
        # exponential backoff, honouring Retry-After. 0 disables retries.
        self._max_retries = max(0, int(max_retries))
        # persistent (lazy) httpx clients — one connection pool per client
        self._client: Optional[httpx.Client] = None
        self._async_client: Optional[httpx.AsyncClient] = None

    # -- shared retry decision -------------------------------------------------

    def _should_retry(
        self,
        method: str,
        status: int,
        accept_statuses: Optional[List[int]],
        attempt: int,
    ) -> bool:
        """Whether a response status is worth another attempt.

        ``attempt`` is the number of retries already made (0-based).
        Statuses the caller explicitly accepts (``accept_statuses``) are never
        retried — the caller wants to handle that status itself.
        """
        if attempt >= self._max_retries:
            return False
        if status not in _RETRYABLE_STATUS:
            return False
        if accept_statuses and status in accept_statuses:
            return False
        if status == 429:
            return True  # gate rejected the request — nothing was processed
        return method.upper() in _IDEMPOTENT_METHODS

    def _build_headers(self, *, with_content_type: bool = True) -> Dict[str, str]:
        headers = {**self._headers}
        if with_content_type:
            headers["Content-Type"] = "application/json"
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        return headers


class UltraContext(_BaseClient):
    """Sync UltraContext API client."""

    # -- lifecycle (SDK-001): one persistent httpx.Client per UltraContext -----

    def _get_client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=self._timeout)
        return self._client

    def close(self) -> None:
        """Close the underlying connection pool (idempotent)."""
        if self._client is not None:
            self._client.close()
            self._client = None

    def __enter__(self) -> "UltraContext":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()
        return None

    # -- request -----------------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        json: Optional[Any] = None,
        accept_statuses: Optional[List[int]] = None,
    ) -> Any:
        """Make HTTP request (persistent client + retries, SDK-001)."""

        # filter None values
        if params:
            params = {k: v for k, v in params.items() if v is not None}

        url = f"{self._base_url}{path}"

        headers = self._build_headers(with_content_type=json is not None)

        client = self._get_client()
        attempt = 0
        while True:
            try:
                response = client.request(
                    method,
                    url,
                    params=params,
                    json=json,
                    headers=headers,
                )
            except httpx.TransportError:
                # network/timeout failure: only safe to retry for idempotent
                # methods — a lost POST may have been processed server-side.
                if (
                    self._max_retries
                    and attempt < self._max_retries
                    and method.upper() in _IDEMPOTENT_METHODS
                ):
                    time.sleep(backoff_delay(attempt))
                    attempt += 1
                    continue
                raise

            if self._should_retry(method, response.status_code, accept_statuses, attempt):
                delay = _retry_after_seconds(response)
                if delay is None:
                    delay = backoff_delay(attempt)
                time.sleep(delay)
                attempt += 1
                continue
            break

        # handle errors — accept_statuses lets callers surface non-2xx bodies (e.g. batch partial-fail)
        accepted = accept_statuses is not None and response.status_code in accept_statuses
        if not response.is_success and not accepted:
            raise UltraContextHttpError(
                f"HTTP {response.status_code}: {response.text}",
                status=response.status_code,
                url=url,
                body=response.text,
            )

        # handle empty response
        if response.status_code == 204 or not response.content:
            return None

        return response.json()

    # --- Methods ---

    def create(
        self,
        *,
        from_: Optional[str] = None,
        version: Optional[int] = None,
        at: Optional[int] = None,
        before: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> CreateContextResponse:
        """
        Create new context or fork from existing.

        Args:
            from_: Source context ID to fork from
            version: Fork from specific version
            at: Fork messages 0 through this index
            before: Fork point-in-time state before timestamp
            metadata: Context metadata
        """
        body: Dict[str, Any] = {}
        if from_ is not None:
            body["from"] = from_
        if version is not None:
            body["version"] = version
        if at is not None:
            body["at"] = at
        if before is not None:
            body["before"] = before
        if metadata is not None:
            body["metadata"] = metadata

        return self._request("POST", "/contexts", json=body or None)

    @overload
    def get(self, *, limit: Optional[int] = None) -> ListContextsResponse: ...

    @overload
    def get(
        self,
        context_id: str,
        *,
        version: Optional[int] = None,
        at: Optional[int] = None,
        before: Optional[str] = None,
        history: Optional[bool] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> GetContextResponse: ...

    def get(
        self,
        context_id: Optional[str] = None,
        *,
        version: Optional[int] = None,
        at: Optional[int] = None,
        before: Optional[str] = None,
        history: Optional[bool] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> Union[GetContextResponse, ListContextsResponse]:
        """
        Get context by ID, or list all contexts.

        Args:
            context_id: Context ID (omit to list all)
            version: Specific version to retrieve
            at: Return messages 0 through this index
            before: Point-in-time state before timestamp
            history: Include version history
            limit: Max contexts when listing (default 20); page size when
                getting a single context (API-010, server-clamped to 1..1000)
            offset: Zero-based start index when getting a single context
                (API-010). Omitting limit/offset always returns the full
                context — nothing is silently truncated.
        """
        # list all contexts
        if context_id is None:
            list_params = {"limit": limit} if limit else None
            return self._request("GET", "/contexts", params=list_params)

        # get single context
        params: Dict[str, Any] = {}
        if version is not None:
            params["version"] = version
        if at is not None:
            params["at"] = at
        if before is not None:
            params["before"] = before
        if history is not None:
            params["history"] = history
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset

        return self._request("GET", f"/contexts/{quote(context_id, safe='')}", params=params or None)

    def append(
        self,
        context_id: str,
        data: Union[Dict[str, Any], List[Dict[str, Any]]],
    ) -> AppendResponse:
        """
        Append messages to context.

        Args:
            context_id: Context ID
            data: Single message or list of messages
        """
        items = data if isinstance(data, list) else [data]
        return self._request("POST", f"/contexts/{quote(context_id, safe='')}", json=items)

    def update(
        self,
        context_id: str,
        updates: Optional[List[Dict[str, Any]]] = None,
        *,
        id: Optional[str] = None,
        index: Optional[int] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **fields: Any,
    ) -> UpdateResponse:
        """
        Update message(s) by id or index.

        Args:
            context_id: Context ID
            updates: List of updates for batch mode (each dict has id/index + fields)
            id: Message ID to update (single mode)
            index: Message index to update, 0=first, -1=last (single mode)
            metadata: Version metadata for audit trail
            **fields: Fields to update on the message (single mode)
        """
        # batch mode
        if updates is not None:
            body: Dict[str, Any] = {"updates": updates}
            if metadata:
                body["metadata"] = metadata
            return self._request("PATCH", f"/contexts/{quote(context_id, safe='')}", json=body)

        # single mode
        body = {**fields}
        if id is not None:
            body["id"] = id
        if index is not None:
            body["index"] = index

        # wrap with version metadata if provided
        if metadata:
            body = {"updates": [body], "metadata": metadata}

        return self._request("PATCH", f"/contexts/{quote(context_id, safe='')}", json=body)

    def delete(
        self,
        context_id: str,
        ids: Optional[Union[str, int, List[Union[str, int]]]] = None,
        *,
        permanent: bool = False,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Union[DeleteResponse, PermanentDeleteResponse]:
        """
        Delete messages (soft, versioned) or the entire context (hard, permanent).

        Args:
            context_id: Context ID
            ids: Message ID, index, or list — soft delete (preserved in prior versions)
            permanent: If True, permanently delete the entire context (irreversible).
                Requires `ids` to be None.
            metadata: Audit metadata — version metadata for soft delete, echoed in
                response for permanent delete
        """
        if permanent:
            if ids is not None:
                raise ValueError("Cannot pass both `ids` and `permanent=True`")
            body: Dict[str, Any] = {"permanent": True}
            if metadata:
                body["metadata"] = metadata
            return self._request("DELETE", f"/contexts/{quote(context_id, safe='')}", json=body)

        if ids is None:
            raise ValueError("Either `ids` (soft delete) or `permanent=True` (hard delete) is required")

        items = ids if isinstance(ids, list) else [ids]
        body = {"ids": items}
        if metadata:
            body["metadata"] = metadata

        return self._request("DELETE", f"/contexts/{quote(context_id, safe='')}", json=body)

    def delete_many(self, ids: List[str]) -> DeleteManyResponse:
        """
        Delete multiple contexts permanently (max 100).

        Status 200 = all succeeded, 207 = partial, 409 = every item failed with a
        retryable serialization conflict (Retry-After header — wait, then retry the
        request verbatim), 500 = all failed otherwise. All four carry a results
        body; this method surfaces the body instead of raising.

        Args:
            ids: List of context IDs to delete
        """
        return self._request("POST", "/contexts/delete-many", json={"ids": ids}, accept_statuses=[200, 207, 409, 500])


class AsyncUltraContext(_BaseClient):
    """Async UltraContext API client."""

    # -- lifecycle (SDK-001): one persistent httpx.AsyncClient per client -------

    def _get_async_client(self) -> httpx.AsyncClient:
        if self._async_client is None:
            self._async_client = httpx.AsyncClient(timeout=self._timeout)
        return self._async_client

    async def close(self) -> None:
        """Close the underlying connection pool (idempotent)."""
        if self._async_client is not None:
            await self._async_client.aclose()
            self._async_client = None

    async def __aenter__(self) -> "AsyncUltraContext":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()
        return None

    # -- request -----------------------------------------------------------------

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        json: Optional[Any] = None,
        accept_statuses: Optional[List[int]] = None,
    ) -> Any:
        """Make async HTTP request (persistent client + retries, SDK-001)."""

        # filter None values
        if params:
            params = {k: v for k, v in params.items() if v is not None}

        url = f"{self._base_url}{path}"

        headers = self._build_headers(with_content_type=json is not None)

        client = self._get_async_client()
        attempt = 0
        while True:
            try:
                response = await client.request(
                    method,
                    url,
                    params=params,
                    json=json,
                    headers=headers,
                )
            except httpx.TransportError:
                # network/timeout failure: only safe to retry for idempotent
                # methods — a lost POST may have been processed server-side.
                if (
                    self._max_retries
                    and attempt < self._max_retries
                    and method.upper() in _IDEMPOTENT_METHODS
                ):
                    await asyncio.sleep(backoff_delay(attempt))
                    attempt += 1
                    continue
                raise

            if self._should_retry(method, response.status_code, accept_statuses, attempt):
                delay = _retry_after_seconds(response)
                if delay is None:
                    delay = backoff_delay(attempt)
                await asyncio.sleep(delay)
                attempt += 1
                continue
            break

        # handle errors — accept_statuses lets callers surface non-2xx bodies
        accepted = accept_statuses is not None and response.status_code in accept_statuses
        if not response.is_success and not accepted:
            raise UltraContextHttpError(
                f"HTTP {response.status_code}: {response.text}",
                status=response.status_code,
                url=url,
                body=response.text,
            )

        # handle empty response
        if response.status_code == 204 or not response.content:
            return None

        return response.json()

    # --- Methods ---

    async def create(
        self,
        *,
        from_: Optional[str] = None,
        version: Optional[int] = None,
        at: Optional[int] = None,
        before: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> CreateContextResponse:
        """Create new context or fork from existing."""
        body: Dict[str, Any] = {}
        if from_ is not None:
            body["from"] = from_
        if version is not None:
            body["version"] = version
        if at is not None:
            body["at"] = at
        if before is not None:
            body["before"] = before
        if metadata is not None:
            body["metadata"] = metadata

        return await self._request("POST", "/contexts", json=body or None)

    @overload
    async def get(self, *, limit: Optional[int] = None) -> ListContextsResponse: ...

    @overload
    async def get(
        self,
        context_id: str,
        *,
        version: Optional[int] = None,
        at: Optional[int] = None,
        before: Optional[str] = None,
        history: Optional[bool] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> GetContextResponse: ...

    async def get(
        self,
        context_id: Optional[str] = None,
        *,
        version: Optional[int] = None,
        at: Optional[int] = None,
        before: Optional[str] = None,
        history: Optional[bool] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> Union[GetContextResponse, ListContextsResponse]:
        """Get context by ID, or list all contexts.

        ``limit``/``offset`` paginate a single context (API-010); omitting
        both always returns the full context.
        """

        # list all contexts
        if context_id is None:
            list_params = {"limit": limit} if limit else None
            return await self._request("GET", "/contexts", params=list_params)

        # get single context
        params: Dict[str, Any] = {}
        if version is not None:
            params["version"] = version
        if at is not None:
            params["at"] = at
        if before is not None:
            params["before"] = before
        if history is not None:
            params["history"] = history
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset

        return await self._request("GET", f"/contexts/{quote(context_id, safe='')}", params=params or None)

    async def append(
        self,
        context_id: str,
        data: Union[Dict[str, Any], List[Dict[str, Any]]],
    ) -> AppendResponse:
        """Append messages to context."""
        items = data if isinstance(data, list) else [data]
        return await self._request("POST", f"/contexts/{quote(context_id, safe='')}", json=items)

    async def update(
        self,
        context_id: str,
        updates: Optional[List[Dict[str, Any]]] = None,
        *,
        id: Optional[str] = None,
        index: Optional[int] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **fields: Any,
    ) -> UpdateResponse:
        """Update message(s) by id or index."""
        # batch mode
        if updates is not None:
            body: Dict[str, Any] = {"updates": updates}
            if metadata:
                body["metadata"] = metadata
            return await self._request("PATCH", f"/contexts/{quote(context_id, safe='')}", json=body)

        # single mode
        body = {**fields}
        if id is not None:
            body["id"] = id
        if index is not None:
            body["index"] = index

        if metadata:
            body = {"updates": [body], "metadata": metadata}

        return await self._request("PATCH", f"/contexts/{quote(context_id, safe='')}", json=body)

    async def delete(
        self,
        context_id: str,
        ids: Optional[Union[str, int, List[Union[str, int]]]] = None,
        *,
        permanent: bool = False,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Union[DeleteResponse, PermanentDeleteResponse]:
        """Delete messages (soft, versioned) or the entire context (hard, permanent=True)."""
        if permanent:
            if ids is not None:
                raise ValueError("Cannot pass both `ids` and `permanent=True`")
            body: Dict[str, Any] = {"permanent": True}
            if metadata:
                body["metadata"] = metadata
            return await self._request("DELETE", f"/contexts/{quote(context_id, safe='')}", json=body)

        if ids is None:
            raise ValueError("Either `ids` (soft delete) or `permanent=True` (hard delete) is required")

        items = ids if isinstance(ids, list) else [ids]
        body = {"ids": items}
        if metadata:
            body["metadata"] = metadata

        return await self._request("DELETE", f"/contexts/{quote(context_id, safe='')}", json=body)

    async def delete_many(self, ids: List[str]) -> DeleteManyResponse:
        """Delete multiple contexts permanently (max 100). 200/207/409/500 all carry a results body."""
        return await self._request("POST", "/contexts/delete-many", json={"ids": ids}, accept_statuses=[200, 207, 409, 500])
