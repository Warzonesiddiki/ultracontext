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

    def __init__(self, *args: Any, **kwargs: Any):
        pass

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
