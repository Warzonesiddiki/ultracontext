"""Offline tests for the UltraContext Python SDK.

httpx is mocked so no network is needed; these verify URL construction,
header handling, body shaping, validation and error surfacing.
"""

import json
from typing import Any, Dict, List, Optional
from unittest import mock

import httpx
import pytest

import ultracontext
from ultracontext import (
    AsyncUltraContext,
    UltraContext,
    UltraContextError,
    UltraContextHttpError,
)


class FakeResponse:
    def __init__(self, status_code: int, body: Any = None, text: Optional[str] = None):
        self.status_code = status_code
        self._body = body
        if text is not None:
            self._content = text.encode("utf-8")
        else:
            self._content = b"" if body is None else json.dumps(body).encode("utf-8")
        self.text = text if text is not None else ("" if body is None else json.dumps(body))

    @property
    def is_success(self) -> bool:
        return 200 <= self.status_code < 300

    @property
    def content(self) -> bytes:
        return self._content

    def json(self) -> Any:
        if self._body is None:
            raise ValueError("no body")
        return self._body


class FakeClient:
    """Records requests and returns the queued response."""

    last_request: Optional[Dict[str, Any]] = None
    queued: List[FakeResponse] = [FakeResponse(200, {})]
    init_kwargs: Dict[str, Any] = {}

    def __init__(self, *args: Any, **kwargs: Any):
        FakeClient.init_kwargs = kwargs

    def __enter__(self) -> "FakeClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    def request(self, method: str, url: str, **kwargs: Any) -> FakeResponse:
        FakeClient.last_request = {"method": method, "url": url, **kwargs}
        return FakeClient.queued.pop(0) if FakeClient.queued else FakeResponse(200, {})


class FakeAsyncClient(FakeClient):
    async def __aenter__(self) -> "FakeAsyncClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    async def request(self, method: str, url: str, **kwargs: Any) -> FakeResponse:
        FakeClient.last_request = {"method": method, "url": url, **kwargs}
        return FakeClient.queued.pop(0) if FakeClient.queued else FakeResponse(200, {})


@pytest.fixture(autouse=True)
def _reset() -> None:
    FakeClient.last_request = None
    FakeClient.queued = [FakeResponse(200, {})]


def client(base_url: str = "http://127.0.0.1:8787", api_key: str = "uc_live_test") -> UltraContext:
    return UltraContext(api_key=api_key, base_url=base_url)


def last() -> Dict[str, Any]:
    assert FakeClient.last_request is not None
    return FakeClient.last_request


# ── package surface ──────────────────────────────────────────────

def test_package_imports_and_version() -> None:
    assert isinstance(ultracontext.__version__, str)
    assert "UltraContext" in ultracontext.__all__
    assert issubclass(UltraContextHttpError, UltraContextError)


# ── URL + header construction ────────────────────────────────────

def test_base_url_trailing_slash_stripped() -> None:
    with mock.patch("httpx.Client", FakeClient):
        client(base_url="http://127.0.0.1:8787/").get()
    assert last()["url"] == "http://127.0.0.1:8787/contexts"


def test_default_base_url() -> None:
    with mock.patch("httpx.Client", FakeClient):
        UltraContext(api_key="uc_live_test").get()
    assert last()["url"].startswith("https://api.ultracontext.ai/contexts")


def test_auth_and_content_type_headers() -> None:
    with mock.patch("httpx.Client", FakeClient):
        c = client()
        c.get("abc")
        headers = last()["headers"]
        assert headers["Authorization"] == "Bearer uc_live_test"
        assert "Content-Type" not in headers  # GET, no body
        c.create()  # no fields → body is None → no Content-Type
        assert "Content-Type" not in last()["headers"]
        c.create(from_="abc")
        assert last()["headers"]["Content-Type"] == "application/json"


def test_no_auth_header_without_key() -> None:
    with mock.patch("httpx.Client", FakeClient):
        UltraContext(base_url="http://127.0.0.1:8787").get()
    assert "Authorization" not in last()["headers"]


def test_context_id_is_url_encoded() -> None:
    with mock.patch("httpx.Client", FakeClient):
        client().get("my proj/sub dir")
    assert last()["url"] == "http://127.0.0.1:8787/contexts/my%20proj%2Fsub%20dir"


# ── params + body shaping ────────────────────────────────────────

def test_none_params_are_filtered() -> None:
    with mock.patch("httpx.Client", FakeClient):
        client().get("abc", version=None, history=None)
        assert last()["params"] is None
        client().get(limit=5)
        assert last()["params"] == {"limit": 5}


def test_get_single_sends_time_travel_params() -> None:
    with mock.patch("httpx.Client", FakeClient):
        client().get("abc", version=2, at=7)
    assert last()["params"] == {"version": 2, "at": 7}
    assert last()["method"] == "GET"


def test_create_body_omits_unset_fields() -> None:
    with mock.patch("httpx.Client", FakeClient):
        client().create()
        assert last()["json"] is None  # no fields → empty body → None
        client().create(from_="abc", version=3, metadata={"k": "v"})
        assert last()["json"] == {"from": "abc", "version": 3, "metadata": {"k": "v"}}


def test_append_wraps_single_message_in_list() -> None:
    with mock.patch("httpx.Client", FakeClient):
        client().append("abc", {"role": "user", "content": "hi"})
        assert last()["json"] == [{"role": "user", "content": "hi"}]
        client().append("abc", [{"role": "user"}, {"role": "assistant"}])
        assert len(last()["json"]) == 2


def test_update_single_mode_wraps_with_metadata() -> None:
    with mock.patch("httpx.Client", FakeClient):
        client().update("abc", index=0, text="new", metadata={"note": "fix"})
    assert last()["json"] == {"updates": [{"text": "new", "index": 0}], "metadata": {"note": "fix"}}
    assert last()["method"] == "PATCH"


def test_update_batch_mode() -> None:
    with mock.patch("httpx.Client", FakeClient):
        client().update("abc", updates=[{"id": "m1", "text": "a"}, {"index": 1, "text": "b"}])
    assert last()["json"] == {"updates": [{"id": "m1", "text": "a"}, {"index": 1, "text": "b"}]}


def test_delete_soft_and_permanent_bodies() -> None:
    with mock.patch("httpx.Client", FakeClient):
        client().delete("abc", "m1")
        assert last()["json"] == {"ids": ["m1"]}
        assert last()["method"] == "DELETE"

        client().delete("abc", permanent=True, metadata={"why": "cleanup"})
        assert last()["json"] == {"permanent": True, "metadata": {"why": "cleanup"}}


def test_delete_requires_ids_or_permanent() -> None:
    c = client()
    with mock.patch("httpx.Client", FakeClient):
        with pytest.raises(ValueError):
            c.delete("abc")
        with pytest.raises(ValueError):
            c.delete("abc", "m1", permanent=True)


def test_delete_many_sends_ids() -> None:
    with mock.patch("httpx.Client", FakeClient):
        client().delete_many(["a", "b"])
    assert last()["json"] == {"ids": ["a", "b"]}
    assert last()["url"].endswith("/contexts/delete-many")


# ── error handling ───────────────────────────────────────────────

def test_non_2xx_raises_http_error_with_details() -> None:
    FakeClient.queued = [FakeResponse(404, None, text="not found")]
    with mock.patch("httpx.Client", FakeClient):
        with pytest.raises(UltraContextHttpError) as excinfo:
            client().get("missing")
    err = excinfo.value
    assert err.status == 404
    assert err.url == "http://127.0.0.1:8787/contexts/missing"
    assert err.body == "not found"


def test_delete_many_surfaces_207_partial() -> None:
    body = {"results": [{"id": "a", "ok": True}, {"id": "b", "ok": False}]}
    FakeClient.queued = [FakeResponse(207, body)]
    with mock.patch("httpx.Client", FakeClient):
        out = client().delete_many(["a", "b"])
    assert out == body


def test_204_returns_none() -> None:
    FakeClient.queued = [FakeResponse(204)]
    with mock.patch("httpx.Client", FakeClient):
        assert client().delete("abc", "m1") is None


# ── async client ─────────────────────────────────────────────────

async def test_async_get_and_auth() -> None:
    with mock.patch("httpx.AsyncClient", FakeAsyncClient):
        c = AsyncUltraContext(api_key="uc_live_test", base_url="http://127.0.0.1:8787")
        out = await c.get("abc", version=1)
    assert last()["url"] == "http://127.0.0.1:8787/contexts/abc"
    assert last()["params"] == {"version": 1}
    assert last()["headers"]["Authorization"] == "Bearer uc_live_test"
    assert out == {}


async def test_async_error_raises() -> None:
    FakeClient.queued = [FakeResponse(500, None, text="boom")]
    with mock.patch("httpx.AsyncClient", FakeAsyncClient):
        c = AsyncUltraContext(api_key="uc_live_test", base_url="http://127.0.0.1:8787")
        with pytest.raises(UltraContextHttpError) as excinfo:
            await c.create()
    assert excinfo.value.status == 500
    assert excinfo.value.body == "boom"


# ── get(): list mode + every selector ────────────────────────────

def test_get_list_mode_no_limit_sends_no_params() -> None:
    with mock.patch("httpx.Client", FakeClient):
        client().get()
    assert last()["method"] == "GET"
    assert last()["url"] == "http://127.0.0.1:8787/contexts"
    assert last()["params"] is None


def test_get_list_mode_with_limit() -> None:
    with mock.patch("httpx.Client", FakeClient):
        client().get(limit=10)
    assert last()["params"] == {"limit": 10}


def test_get_single_sends_all_selectors() -> None:
    with mock.patch("httpx.Client", FakeClient):
        client().get("abc", version=2, at=7, before="2026-01-01T00:00:00Z", history=True)
    assert last()["params"] == {
        "version": 2,
        "at": 7,
        "before": "2026-01-01T00:00:00Z",
        "history": True,
    }


def test_get_single_sends_pagination_params() -> None:
    # API-010: limit/offset paginate a single context
    with mock.patch("httpx.Client", FakeClient):
        client().get("abc", limit=50, offset=100)
    assert last()["params"] == {"limit": 50, "offset": 100}


def test_get_single_without_pagination_sends_no_params() -> None:
    # omitting both always returns the full context — no params at all
    with mock.patch("httpx.Client", FakeClient):
        client().get("abc")
    assert last()["params"] is None


# ── response body handling ───────────────────────────────────────

def test_success_returns_parsed_json() -> None:
    FakeClient.queued = [FakeResponse(201, {"id": "ctx_1", "created_at": "2026-01-01T00:00:00Z"})]
    with mock.patch("httpx.Client", FakeClient):
        out = client().create()
    assert out == {"id": "ctx_1", "created_at": "2026-01-01T00:00:00Z"}


def test_200_with_empty_body_returns_none() -> None:
    # success with no content — e.g. an adapter that sends an empty 200
    FakeClient.queued = [FakeResponse(200, None, text="")]
    with mock.patch("httpx.Client", FakeClient):
        assert client().get("abc") is None


# ── error mapping (API error contract: {error, code}) ────────────

def test_error_carries_machine_readable_code_from_api() -> None:
    FakeClient.queued = [FakeResponse(404, {"error": "Context not found", "code": "not_found"})]
    with mock.patch("httpx.Client", FakeClient):
        with pytest.raises(UltraContextHttpError) as excinfo:
            client().get("missing")
    err = excinfo.value
    assert err.status == 404
    assert json.loads(err.body) == {"error": "Context not found", "code": "not_found"}
    assert "404" in str(err)


def test_400_invalid_input_raises() -> None:
    FakeClient.queued = [FakeResponse(400, {"error": "limit must be a positive integer", "code": "invalid_input"})]
    with mock.patch("httpx.Client", FakeClient):
        with pytest.raises(UltraContextHttpError) as excinfo:
            client().get(limit=0)
    assert excinfo.value.status == 400


def test_401_unauthenticated_raises() -> None:
    FakeClient.queued = [FakeResponse(401, None, text="Unauthorized")]
    with mock.patch("httpx.Client", FakeClient):
        with pytest.raises(UltraContextHttpError) as excinfo:
            client().get("abc")
    assert excinfo.value.status == 401


def test_409_conflict_raises_with_retryable_body() -> None:
    # a non-delete_many request that hit an SSI conflict: the API answers
    # 409 + Retry-After with code=conflict; the client raises, exposing the
    # body so the caller can back off (Retry-After) and retry verbatim
    FakeClient.queued = [FakeResponse(409, {"error": "Concurrent write conflict — retry the request", "code": "conflict"})]
    with mock.patch("httpx.Client", FakeClient):
        with pytest.raises(UltraContextHttpError) as excinfo:
            client().append("abc", {"role": "user", "content": "x"})
    err = excinfo.value
    assert err.status == 409
    assert json.loads(err.body)["code"] == "conflict"


def test_500_internal_raises() -> None:
    FakeClient.queued = [FakeResponse(500, {"error": "Failed to append messages", "code": "internal"})]
    with mock.patch("httpx.Client", FakeClient):
        with pytest.raises(UltraContextHttpError) as excinfo:
            client().append("abc", {"role": "user", "content": "x"})
    assert excinfo.value.status == 500


# ── delete_many status semantics (200 / 207 / 409 / 500) ─────────

def _dm_body(retryable: bool = False) -> Dict[str, Any]:
    return {
        "results": [
            {
                "id": "a",
                "deleted": False,
                "error": "Concurrent write conflict — retry the request" if retryable else "boom",
                **({"retryable": True} if retryable else {}),
            }
        ],
        "deleted_count": 0,
    }


def test_delete_many_200_all_ok_returns_body() -> None:
    body = {"results": [{"id": "a", "deleted": True}], "deleted_count": 1}
    FakeClient.queued = [FakeResponse(200, body)]
    with mock.patch("httpx.Client", FakeClient):
        assert client().delete_many(["a"]) == body


def test_delete_many_500_all_failed_returns_body_without_raising() -> None:
    FakeClient.queued = [FakeResponse(500, _dm_body())]
    with mock.patch("httpx.Client", FakeClient):
        out = client().delete_many(["a"])
    assert out == _dm_body()


def test_delete_many_409_all_conflicted_returns_body_without_raising() -> None:
    # every item failed with an SSI conflict → 409 + Retry-After at the API;
    # the results body is surfaced (per-item retryable flag) instead of a raise
    FakeClient.queued = [FakeResponse(409, _dm_body(retryable=True))]
    with mock.patch("httpx.Client", FakeClient):
        out = client().delete_many(["a"])
    assert out["results"][0]["retryable"] is True


def test_delete_many_400_invalid_input_still_raises() -> None:
    FakeClient.queued = [FakeResponse(400, {"error": "ids must be a non-empty array of context IDs", "code": "invalid_input"})]
    with mock.patch("httpx.Client", FakeClient):
        with pytest.raises(UltraContextHttpError) as excinfo:
            client().delete_many([])
    assert excinfo.value.status == 400


# ── delete / update variations ───────────────────────────────────

def test_delete_by_single_index_wraps_in_list() -> None:
    with mock.patch("httpx.Client", FakeClient):
        client().delete("abc", 3)
    assert last()["json"] == {"ids": [3]}


def test_delete_by_index_list_kept_verbatim() -> None:
    with mock.patch("httpx.Client", FakeClient):
        client().delete("abc", [0, -1])
    assert last()["json"] == {"ids": [0, -1]}


def test_delete_soft_with_metadata() -> None:
    with mock.patch("httpx.Client", FakeClient):
        client().delete("abc", "m1", metadata={"why": "cleanup"})
    assert last()["json"] == {"ids": ["m1"], "metadata": {"why": "cleanup"}}


def test_update_single_mode_by_id_without_metadata_is_flat() -> None:
    # no metadata → the single update goes out flat, not wrapped in "updates"
    with mock.patch("httpx.Client", FakeClient):
        client().update("abc", id="m1", text="t")
    assert last()["json"] == {"id": "m1", "text": "t"}


def test_update_batch_mode_with_metadata() -> None:
    with mock.patch("httpx.Client", FakeClient):
        client().update("abc", updates=[{"id": "m1", "text": "a"}], metadata={"note": "audit"})
    assert last()["json"] == {"updates": [{"id": "m1", "text": "a"}], "metadata": {"note": "audit"}}


# ── config: timeout + custom headers ─────────────────────────────

def test_default_timeout_passed_to_httpx() -> None:
    with mock.patch("httpx.Client", FakeClient):
        client().get("abc")
    assert FakeClient.init_kwargs["timeout"] == 30.0


def test_custom_timeout_passed_to_httpx() -> None:
    with mock.patch("httpx.Client", FakeClient):
        UltraContext(api_key="uc_live_test", base_url="http://127.0.0.1:8787", timeout=5.5).get("abc")
    assert FakeClient.init_kwargs["timeout"] == 5.5


def test_custom_headers_merged_with_auth() -> None:
    with mock.patch("httpx.Client", FakeClient):
        UltraContext(api_key="uc_live_test", base_url="http://127.0.0.1:8787", headers={"X-Debug": "1"}).get("abc")
    headers = last()["headers"]
    assert headers["X-Debug"] == "1"
    assert headers["Authorization"] == "Bearer uc_live_test"


# ── async client parity ──────────────────────────────────────────

async def test_async_append_wraps_single_message() -> None:
    with mock.patch("httpx.AsyncClient", FakeAsyncClient):
        c = AsyncUltraContext(api_key="uc_live_test", base_url="http://127.0.0.1:8787")
        await c.append("abc", {"role": "user", "content": "hi"})
    assert last()["json"] == [{"role": "user", "content": "hi"}]


async def test_async_get_list_with_limit() -> None:
    with mock.patch("httpx.AsyncClient", FakeAsyncClient):
        c = AsyncUltraContext(api_key="uc_live_test", base_url="http://127.0.0.1:8787")
        await c.get(limit=3)
    assert last()["url"] == "http://127.0.0.1:8787/contexts"
    assert last()["params"] == {"limit": 3}


async def test_async_delete_many_207_and_409_surface_body() -> None:
    with mock.patch("httpx.AsyncClient", FakeAsyncClient):
        c = AsyncUltraContext(api_key="uc_live_test", base_url="http://127.0.0.1:8787")
        FakeClient.queued = [FakeResponse(207, _dm_body())]
        out207 = await c.delete_many(["a"])
        assert out207["deleted_count"] == 0

        FakeClient.queued = [FakeResponse(409, _dm_body(retryable=True))]
        out409 = await c.delete_many(["a"])
        assert out409["results"][0]["retryable"] is True


async def test_async_delete_validation_raises_without_request() -> None:
    FakeClient.last_request = None
    with mock.patch("httpx.AsyncClient", FakeAsyncClient):
        c = AsyncUltraContext(api_key="uc_live_test", base_url="http://127.0.0.1:8787")
        with pytest.raises(ValueError):
            await c.delete("abc")
    assert FakeClient.last_request is None  # validation happens before any HTTP
