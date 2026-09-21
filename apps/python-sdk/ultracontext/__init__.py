"""UltraContext - The context API for AI agents."""

from .client import AsyncUltraContext, UltraContext
from .exceptions import UltraContextError, UltraContextHttpError
from .types import (
    AppendResponse,
    BranchListResponse,
    BranchRef,
    Context,
    CreateContextResponse,
    DeleteBranchResponse,
    DeleteManyResponse,
    DeleteManyResult,
    DeleteResponse,
    GetContextResponse,
    ListContextsResponse,
    Message,
    PermanentDeleteResponse,
    UpdateResponse,
    Version,
    VersionSelector,
)

# Kept in lockstep with pyproject.toml (they had drifted: 1.1.0 here vs 1.3.0
# there). ARCH-001 adds named branches + immutable version ids → minor bump.
__version__ = "1.4.0"
__all__ = [
    # clients
    "UltraContext",
    "AsyncUltraContext",
    # exceptions
    "UltraContextError",
    "UltraContextHttpError",
    # types
    "Context",
    "Message",
    "Version",
    "VersionSelector",
    "BranchRef",
    "BranchListResponse",
    "DeleteBranchResponse",
    "CreateContextResponse",
    "ListContextsResponse",
    "GetContextResponse",
    "AppendResponse",
    "UpdateResponse",
    "DeleteResponse",
    "PermanentDeleteResponse",
    "DeleteManyResult",
    "DeleteManyResponse",
]
