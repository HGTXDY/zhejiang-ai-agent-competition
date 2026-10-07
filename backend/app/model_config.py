"""Runtime model configuration adapted from Sheldon's agent settings service.

The competition app keeps environment variables as deployment defaults while
allowing a local operator to switch the recipe parser at runtime. Secrets are
never returned by the API and are deliberately kept in process memory rather
than written to the repository or browser storage.
"""
from __future__ import annotations

import os
from threading import RLock
from typing import Any
from urllib.parse import urlparse

from app.parser.llm import OpenAICompatClient

DEFAULT_MODEL = "gpt-4o-mini"


def mask_api_key(value: str) -> str:
    if len(value) <= 8:
        return "*" * len(value)
    return f"{value[:4]}{'*' * (len(value) - 8)}{value[-4:]}"


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _validate_base_url(value: str | None) -> str | None:
    if value is None:
        return None
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Base URL 必须是有效的 http(s) 地址")
    return value.rstrip("/")


class ModelConfigService:
    """Own the active parser/model settings for one API process."""

    def __init__(self) -> None:
        self._lock = RLock()
        self._load_environment_defaults()

    def _load_environment_defaults(self) -> None:
        self._base_url = _optional_text(os.getenv("MODEL_BASE_URL"))
        self._api_key = _optional_text(os.getenv("MODEL_API_KEY"))
        self._model = _optional_text(os.getenv("MODEL_NAME")) or DEFAULT_MODEL
        requested = _optional_text(os.getenv("MODEL_PARSER_PROVIDER")) or "deterministic"
        self._parser_provider = "llm" if requested == "llm" and self._configured() else "deterministic"
        self._source = "environment" if any((self._base_url, self._api_key, os.getenv("MODEL_NAME"))) else "runtime"

    def _configured(self) -> bool:
        return bool(self._base_url and self._api_key and self._model)

    def public_settings(self) -> dict[str, Any]:
        with self._lock:
            configured = self._configured()
            return {
                "parser_provider": self._parser_provider,
                "configured": configured,
                "ready": configured,
                "base_url": self._base_url,
                "model": self._model,
                "api_key_masked": mask_api_key(self._api_key) if self._api_key else None,
                "source": self._source,
                "notes": [
                    "AI 仅负责把菜谱文本结构化；Schema 校验、设备硬约束和 CP-SAT 排程仍由确定性链路执行。",
                    "API Key 只保存在当前后端进程内，查询接口不会返回明文；正式部署可继续使用 MODEL_* 环境变量。",
                ],
            }

    def update(self, payload: dict[str, Any]) -> dict[str, Any]:
        allowed = {"parser_provider", "base_url", "model", "api_key", "clear_api_key"}
        unknown = set(payload) - allowed
        if unknown:
            raise ValueError(f"不支持的模型配置字段：{', '.join(sorted(unknown))}")
        with self._lock:
            base_url = _validate_base_url(_optional_text(payload.get("base_url"))) if "base_url" in payload else self._base_url
            model = _optional_text(payload.get("model")) if "model" in payload else self._model
            api_key = self._api_key
            if payload.get("clear_api_key") is True:
                api_key = None
            elif _optional_text(payload.get("api_key")) is not None:
                api_key = _optional_text(payload.get("api_key"))
            provider = _optional_text(payload.get("parser_provider")) or self._parser_provider
            if provider not in {"deterministic", "llm"}:
                raise ValueError("parser_provider 只能是 deterministic 或 llm")
            if provider == "llm" and not (base_url and api_key and model):
                raise ValueError("启用 AI 增强解析前，请完整填写 Base URL、API Key 和模型名称")
            self._base_url = base_url
            self._model = model or DEFAULT_MODEL
            self._api_key = api_key
            self._parser_provider = provider if provider != "llm" or self._configured() else "deterministic"
            self._source = "runtime"
            return self.public_settings()

    def reset(self) -> dict[str, Any]:
        with self._lock:
            self._load_environment_defaults()
            return self.public_settings()

    def build_client(self, payload: dict[str, Any] | None = None, *, timeout_sec: float = 30.0) -> OpenAICompatClient:
        payload = payload or {}
        with self._lock:
            base_url = _validate_base_url(_optional_text(payload.get("base_url"))) if "base_url" in payload else self._base_url
            model = _optional_text(payload.get("model")) if "model" in payload else self._model
            api_key = _optional_text(payload.get("api_key")) or self._api_key
        if not base_url or not api_key or not model:
            raise ValueError("模型尚未配置，请填写 Base URL、API Key 和模型名称")
        return OpenAICompatClient(base_url=base_url, api_key=api_key, model=model, timeout_sec=timeout_sec)

    def active_client(self) -> OpenAICompatClient:
        return self.build_client()

    def probe(self, payload: dict[str, Any]) -> dict[str, Any]:
        client = self.build_client(payload, timeout_sec=15.0)
        client.complete(
            "You are a connectivity probe. Follow the user instruction exactly.",
            "Reply with only OK.",
        )
        with self._lock:
            model = _optional_text(payload.get("model")) or self._model
            base_url = _optional_text(payload.get("base_url")) or self._base_url
        return {"ok": True, "model": model, "base_url": base_url, "message": "模型连接成功，Chat Completions 接口可用"}
