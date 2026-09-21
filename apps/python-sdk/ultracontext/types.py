"""UltraContext type definitions."""

from typing import Any, Dict, List, Optional, TypedDict, Union

# A version address (ARCH-001): an immutable version id (``ctx_...``, the form
# to prefer) or a positional index (a deprecated alias, kept so existing code
# keeps working). Negative indexes count back from the head, so ``-1`` is the
# latest version.
VersionSelector = Union[int, str]


class Context(TypedDict):
    """Context object returned from list()."""

    id: str
    metadata: Dict[str, Any]
    created_at: str


class Message(TypedDict, total=False):
    """Message in a context."""

    id: str
    index: int
    role: str
    content: str
    metadata: Dict[str, Any]


class Version(TypedDict, total=False):
    """Version history entry.

    Address a version by ``id`` (ARCH-001): it is the version head's public id,
    it never moves and is never reused, so a stored reference keeps meaning the
    same thing as the chain grows. ``version`` is the deprecated positional
    alias -- recomputed at read time, so it shifts as versions are added.
    """

    version: int
    id: str
    created_at: str
    operation: str
    affected: Optional[List[str]]
    metadata: Optional[Dict[str, Any]]


class BranchRef(TypedDict):
    """A named branch (ARCH-001): a stable name pinned to an immutable version id.

    ``version`` is the pinned version's positional index at read time, and -1
    when the pinned head is no longer part of the chain (its version node was
    deleted) -- the name and ``version_id`` survive that, the index cannot.
    """

    name: str
    version_id: str
    version: int
    created_at: str
    updated_at: str


class BranchListResponse(TypedDict):
    """Response from branches()."""

    branches: List[BranchRef]


class DeleteBranchResponse(TypedDict):
    """Response from delete_branch() -- the pointer was removed, never the data."""

    deleted: bool
    name: str


class CreateContextResponse(TypedDict):
    """Response from create()."""

    id: str
    metadata: Optional[Dict[str, Any]]
    created_at: str


class ListContextsResponse(TypedDict):
    """Response from get() when listing all contexts."""

    data: List[Context]


class GetContextResponse(TypedDict, total=False):
    """Response from get()."""

    data: List[Message]
    version: int
    versions: List[Version]
    # pagination (API-010) — present only when limit/offset was requested
    total: int
    limit: int
    offset: int


class AppendResponse(TypedDict):
    """Response from append()."""

    data: List[Message]
    version: int


class UpdateResponse(TypedDict):
    """Response from update()."""

    data: List[Message]
    version: int


class DeleteResponse(TypedDict):
    """Response from delete()."""

    data: List[Message]
    version: int


class PermanentDeleteResponse(TypedDict, total=False):
    """Response from delete(..., permanent=True)."""

    deleted: bool
    id: str
    metadata: Optional[Dict[str, Any]]


class DeleteManyResult(TypedDict, total=False):
    """Single result from delete_many()."""

    id: str
    deleted: bool
    error: Optional[str]
    retryable: bool


class DeleteManyResponse(TypedDict, total=False):
    """Response from delete_many()."""

    results: List[DeleteManyResult]
    deleted_count: int
