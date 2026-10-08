"""Network-layer regressions for the stateless LLM completion client.

The fake transport deliberately never contacts a real LLM or uses a real key.
"""
import http.client
import json
import urllib.error

import pytest

from app.parser.adapter import ParsedTaskError
from app.parser.llm import OpenAICompatClient


class _Response:
    def __init__(self, body: bytes):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.body


def _good_response():
    return _Response(json.dumps({"choices": [{"message": {"content": "好的"}}]}).encode())


def _client():
    return OpenAICompatClient(
        base_url="https://provider.example.test/v1",
        api_key="test-secret-must-not-leak",
        model="demo-model",
    )


def _mock_transport(monkeypatch, effects):
    import app.parser.llm as llm

    queue = iter(effects)
    calls = []

    def urlopen(request, timeout):
        calls.append((request, timeout))
        effect = next(queue)
        if isinstance(effect, Exception):
            raise effect
        return effect

    monkeypatch.setattr(llm.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(llm.time, "sleep", lambda _duration: None)
    return calls


def _http_error(status):
    return urllib.error.HTTPError(
        "https://provider.example.test/v1/chat/completions", status, "server error", None, None
    )


def test_two_incomplete_reads_then_success_reuse_identical_messages(monkeypatch):
    calls = _mock_transport(monkeypatch, [
        http.client.IncompleteRead(b"partial"),
        http.client.IncompleteRead(b"partial"),
        _good_response(),
    ])
    assert _client().complete("系统提示", "加一道菜") == "好的"
    assert len(calls) == 3
    assert all(call[0].get_method() == "POST" for call in calls)
    assert len({call[0].data for call in calls}) == 1


def test_remote_disconnect_then_success(monkeypatch):
    calls = _mock_transport(monkeypatch, [http.client.RemoteDisconnected("connection closed"), _good_response()])
    assert _client().complete("sys", "user") == "好的"
    assert len(calls) == 2


def test_three_transient_failures_surface_safe_error(monkeypatch):
    calls = _mock_transport(monkeypatch, [urllib.error.URLError("broken") for _ in range(3)])
    with pytest.raises(ParsedTaskError, match="连接意外中断") as caught:
        _client().complete("sys", "user")
    assert len(calls) == 3
    assert "test-secret-must-not-leak" not in str(caught.value)
    assert "provider.example.test" not in str(caught.value)


@pytest.mark.parametrize("status", [408, 429, 500, 502, 503, 504])
def test_transient_http_status_retried(monkeypatch, status):
    calls = _mock_transport(monkeypatch, [_http_error(status), _good_response()])
    assert _client().complete("sys", "user") == "好的"
    assert len(calls) == 2


@pytest.mark.parametrize("status", [400, 401, 403, 404])
def test_permanent_http_status_not_retried(monkeypatch, status):
    calls = _mock_transport(monkeypatch, [_http_error(status)])
    with pytest.raises(ParsedTaskError) as caught:
        _client().complete("sys", "user")
    assert len(calls) == 1
    assert f"HTTP {status}" in str(caught.value)
    assert "test-secret-must-not-leak" not in str(caught.value)


def test_exhausted_rate_limit_distinguishable_from_network_error(monkeypatch):
    calls = _mock_transport(monkeypatch, [_http_error(429)] * 3)
    with pytest.raises(ParsedTaskError, match="额度受限"):
        _client().complete("sys", "user")
    assert len(calls) == 3


def test_malformed_response_not_retried(monkeypatch):
    calls = _mock_transport(monkeypatch, [_Response(b"<html>not json</html>")])
    with pytest.raises(ParsedTaskError, match="数据格式异常"):
        _client().complete("sys", "user")
    assert len(calls) == 1


def test_empty_model_content_not_retried(monkeypatch):
    calls = _mock_transport(monkeypatch, [_Response(b'{"choices": [{"message": {"content": null}}]}')])
    with pytest.raises(ParsedTaskError, match="模型回复内容为空"):
        _client().complete("sys", "user")
    assert len(calls) == 1
