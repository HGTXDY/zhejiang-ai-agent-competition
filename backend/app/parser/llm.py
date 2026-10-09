"""LLM-backed recipe parser implementing `ParserAdapter`.

This is the competition-facing parser: it sends the versioned prompt from
`app.parser.prompts` to an OpenAI-compatible chat-completions endpoint, coerces
the model's JSON into schema-valid V1 tasks, and lets the deterministic rule
parser backfill any field the model omitted. The result is a hybrid pipeline —
the model does the natural-language reasoning, the rule layer guarantees the
output satisfies `task.schema.json` no matter how the model responds.

Configuration comes from the environment (see `.env.example`):

* ``MODEL_BASE_URL`` — OpenAI-compatible base URL (e.g. ``https://api.openai.com/v1``)
* ``MODEL_API_KEY``  — API key
* ``MODEL_NAME``     — model id (default ``gpt-4o-mini``)

The HTTP client is injectable so tests run against a fake without a network.
"""
from __future__ import annotations

import http.client
import json
import os
import re
import time
import urllib.error
import urllib.request
from typing import Any, Protocol

from app.parser.adapter import ParsedTaskError
from app.parser.deterministic import DeterministicParserAdapter
from app.parser.prompts import SYSTEM_PROMPT, build_user_prompt

DEVICE_TYPES = {
    "range_hood",
    "stove",
    "steamer",
    "oven",
    "refrigerator",
    "dishwasher",
    "water_purifier",
}

# These are the only capability modes exposed by the competition device contract.
# The model may suggest a natural-language mode, but unsupported values must not
# leak into the scheduler; the deterministic baseline remains authoritative.
DEVICE_MODES = {
    "range_hood": {"high", "low"},
    "stove": {"boil", "high_heat", "medium_heat", "low_heat", "pan_fry", "deep_fry", "stew", "stir_fry", "simmer"},
    "steamer": {"gentle_steam", "defat_steam", "multi_layer_steam", "normal_steam"},
    "oven": {"air_fry", "upper_lower_heat", "full_grill", "convection", "top_heat", "humid_bake", "circulating", "defat_roast", "dehydrate", "proof", "bake"},
    "refrigerator": {"thaw", "freeze", "chill"},
    "dishwasher": {"baby_care", "deep_clean", "daily"},
    "water_purifier": {"coffee", "instant_heat"},
}

_MIN_TEMPERATURE_C = -50
_MAX_TEMPERATURE_C = 500
_MAX_DURATION_SEC = 86400


class LLMClient(Protocol):
    def complete(self, system: str, user: str) -> str:
        """Return the model's text for a system/user message pair."""


# Only a stateless model-completion POST is retried. Never retry scheduling,
# device updates or other state-changing application requests.
_RETRYABLE_HTTP_STATUSES = {408, 429, 500, 502, 503, 504}
_RETRY_DELAYS_SEC = (0.3, 0.8)  # At most two additional attempts.
_NETWORK_ERRORS = (
    urllib.error.URLError,
    http.client.HTTPException,  # IncompleteRead / RemoteDisconnected / BadStatusLine.
    ConnectionError,
    TimeoutError,
)


def _http_failure_message(status: int) -> str:
    # Do not echo the provider's response body, URL or authorization header.
    if status in {401, 403}:
        return f"模型服务认证失败（HTTP {status}），请检查 API Key 和访问权限"
    if status == 404:
        return "模型接口不存在（HTTP 404），请检查服务地址和模型名称"
    if status == 429:
        return "模型服务请求过于频繁或额度受限（HTTP 429），请稍后重试"
    if status in {408, 500, 502, 503, 504}:
        return f"模型服务暂时不可用（HTTP {status}），请稍后重试"
    return f"模型服务拒绝请求（HTTP {status}），请检查模型配置和接口参数"


class OpenAICompatClient:
    """Minimal OpenAI-compatible chat-completions client (no SDK dependency).

    A bounded retry only handles transient transport errors or selected 5xx/429
    responses. A provider may have processed a completion before the connection
    drops, so retries can incur additional model usage; never loop indefinitely.
    """

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        timeout_sec: float = 30.0,
    ) -> None:
        self._url = base_url.rstrip("/") + "/chat/completions"
        self._api_key = api_key
        self._model = model
        self._timeout_sec = timeout_sec

    def complete(self, system: str, user: str) -> str:
        payload = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0,
        }
        request = urllib.request.Request(
            self._url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._api_key}",
            },
            method="POST",
        )

        # The frontend's request timeout is 70 seconds. Bound the complete
        # operation to 60 seconds even when all individual attempts time out.
        deadline = time.monotonic() + min(60.0, self._timeout_sec * 3)
        body: Any = None
        for attempt in range(len(_RETRY_DELAYS_SEC) + 1):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ParsedTaskError("模型服务响应超时，请稍后重新发送")
            try:
                with urllib.request.urlopen(request, timeout=min(self._timeout_sec, remaining)) as response:
                    body = json.loads(response.read().decode("utf-8"))
                break
            except urllib.error.HTTPError as error:
                # Authentication, invalid input, invalid model, etc. will not
                # improve on retry. Never disclose the upstream error body.
                if error.code not in _RETRYABLE_HTTP_STATUSES or attempt == len(_RETRY_DELAYS_SEC):
                    raise ParsedTaskError(_http_failure_message(error.code)) from error
                failure_message = _http_failure_message(error.code)
            except _NETWORK_ERRORS as error:
                if isinstance(error, TimeoutError):
                    failure_message = "模型服务响应超时，请稍后重试"
                else:
                    failure_message = "模型服务连接意外中断，请稍后重试"
                if attempt == len(_RETRY_DELAYS_SEC):
                    raise ParsedTaskError(failure_message) from error
            except (json.JSONDecodeError, UnicodeDecodeError) as error:
                # A received but malformed response is a content error, not a
                # transient connection failure. Do not retry malformed output.
                raise ParsedTaskError("模型服务返回的数据格式异常，请重试") from error

            # Respect the same total deadline when waiting between attempts.
            pause = min(_RETRY_DELAYS_SEC[attempt], max(0.0, deadline - time.monotonic()))
            if pause <= 0:
                raise ParsedTaskError(failure_message)
            time.sleep(pause)

        try:
            content = body["choices"][0]["message"]["content"]
            if not isinstance(content, str) or not content.strip():
                raise ValueError("empty content")
            return content
        except (KeyError, IndexError, TypeError, ValueError) as error:
            raise ParsedTaskError("模型回复内容为空或缺少必要字段") from error


def extract_json_array(text: str) -> list[Any]:
    """Recover a JSON array from a model reply that may wrap it in prose/fences.

    Raises `ParsedTaskError` when the reply contains no JSON array, so the API
    can surface a parse failure instead of scheduling from garbage.
    """
    if not isinstance(text, str) or not text.strip():
        raise ParsedTaskError("LLM returned an empty response")
    stripped = re.sub(r"```(?:json)?", "", text).strip()
    start = stripped.find("[")
    end = stripped.rfind("]")
    if start == -1 or end <= start:
        raise ParsedTaskError("LLM response contains no JSON array")
    try:
        parsed = json.loads(stripped[start : end + 1])
    except json.JSONDecodeError as error:
        raise ParsedTaskError(f"LLM response is not valid JSON: {error}") from error
    if not isinstance(parsed, list):
        # Some models wrap the array in an object with a "tasks" key.
        if isinstance(parsed, dict) and isinstance(parsed.get("tasks"), list):
            return parsed["tasks"]
        raise ParsedTaskError("LLM response JSON is not an array")
    return parsed


def _as_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def _coerce_duration(value: Any) -> int | None:
    seconds = _as_int(value)
    if seconds is None or seconds <= 0:
        return None
    return min(seconds, _MAX_DURATION_SEC)


def _coerce_temperature(value: Any) -> int | None:
    temperature = _as_int(value)
    if temperature is None:
        return None
    return max(_MIN_TEMPERATURE_C, min(_MAX_TEMPERATURE_C, temperature))


class LLMParserAdapter:
    """`ParserAdapter` that structures recipes with an LLM and rules backfill.

    Every emitted task is valid by construction: the deterministic adapter
    produces a schema-valid baseline for each step, and the model's fields are
    only overlaid when they are individually valid. Unknown or malformed model
    output therefore degrades gracefully instead of breaking the pipeline.
    """

    provider = "llm"

    def __init__(
        self,
        client: LLMClient | None = None,
        *,
        strict: bool = False,
        fallback: DeterministicParserAdapter | None = None,
    ) -> None:
        self.client = client if client is not None else self._default_client()
        self.strict = strict
        # LLM items are indexed 1:1 to original source steps. Keep that
        # baseline unchanged while deterministic parsing can split mixed steps.
        self._fallback = fallback or DeterministicParserAdapter(strict=strict, split_compound=False)

    @staticmethod
    def _default_client() -> OpenAICompatClient | None:
        base_url = os.getenv("MODEL_BASE_URL")
        api_key = os.getenv("MODEL_API_KEY")
        if not base_url or not api_key:
            return None
        return OpenAICompatClient(
            base_url=base_url,
            api_key=api_key,
            model=os.getenv("MODEL_NAME", "gpt-4o-mini"),
        )

    def parse(self, recipe: dict[str, Any]) -> list[dict[str, Any]]:
        if self.client is None:
            raise ParsedTaskError(
                "LLM parser is not configured; set MODEL_BASE_URL, MODEL_API_KEY and MODEL_NAME"
            )
        steps = recipe["steps_text"]
        raw = self.client.complete(SYSTEM_PROMPT, build_user_prompt(recipe))
        llm_items = extract_json_array(raw)
        llm_by_index = _index_llm_items(llm_items, len(steps))
        baseline_by_index = {
            task["source_step_index"]: task for task in self._fallback.parse(recipe)
        }
        tasks = [
            self._merge(recipe, index, step, baseline_by_index.get(index), llm_by_index.get(index))
            for index, step in enumerate(steps)
        ]
        # Overlay valid predecessors (LLM dependency reasoning) onto the chain.
        for index, task in enumerate(tasks):
            raw_predecessors = (llm_by_index.get(index) or {}).get("predecessors")
            if raw_predecessors is None:
                continue
            task["predecessors"] = _resolve_predecessors(raw_predecessors, index, tasks)
        return tasks

    def _merge(
        self,
        recipe: dict[str, Any],
        index: int,
        step_text: str,
        baseline: dict[str, Any] | None,
        llm_item: dict[str, Any] | None,
    ) -> dict[str, Any]:
        # `_fallback.parse` is deterministic and index-aligned, so a baseline
        # always exists. Keeping this guard cheap protects against future drift.
        if baseline is None:
            baseline = self._fallback.parse(recipe)[index]
        task: dict[str, Any] = dict(baseline)
        llm = llm_item if isinstance(llm_item, dict) else {}
        field_status = dict(baseline.get("field_status", {}))

        device_type = llm.get("device_type")
        baseline_requirement = baseline.get("device_requirement") or {}
        if device_type in DEVICE_TYPES:
            # The deterministic parser is authoritative for an already
            # identified device: a model can enrich a missing requirement, but
            # cannot silently turn a steamer step into an oven step. This keeps
            # recipe semantics and physical-capability checks aligned.
            if baseline_requirement and baseline_requirement.get("device_type") != device_type:
                requirement = dict(baseline_requirement)
                field_status["device_type"] = "inferred"
            else:
                requirement = dict(baseline_requirement)
                requirement["device_type"] = device_type
                field_status["device_type"] = "provided"
            # A device inferred only by the LLM has no deterministic
            # requirement to inherit. Keep the merged object schema-valid and
            # schedulable by using the V1 single-capacity default.
            requirement.setdefault("capacity_units", 1)
            # A model-changed device type may inherit a mode from the
            # deterministic baseline that is valid only for the old type.
            # Drop that stale mode before considering the model's suggestion.
            if requirement.get("mode") not in DEVICE_MODES.get(requirement["device_type"], set()):
                requirement.pop("mode", None)
            task["device_requirement"] = requirement

        mode = llm.get("mode")
        requirement = task.get("device_requirement")
        normalized_mode = mode.strip() if isinstance(mode, str) else ""
        device_type_for_mode = requirement.get("device_type") if requirement else None
        if (
            requirement is not None
            and normalized_mode
            and normalized_mode in DEVICE_MODES.get(device_type_for_mode, set())
        ):
            requirement["mode"] = normalized_mode
            field_status["device_mode"] = "provided"
        elif requirement is not None and normalized_mode:
            # Keep the deterministic mode rather than allowing an unsupported
            # model-generated value such as ``roast`` to reach CP-SAT.
            field_status["device_mode"] = "inferred"

        temperature = _coerce_temperature(llm.get("temperature_c"))
        if requirement is not None and temperature is not None:
            requirement["temperature_c"] = temperature
            field_status["temperature_c"] = "provided"

        duration = _coerce_duration(llm.get("duration_sec"))
        if duration is None and _as_int(llm.get("duration_minutes")) is not None:
            duration = _coerce_duration(_as_int(llm.get("duration_minutes")) * 60)
        if duration is not None:
            task["duration_sec"] = duration
            field_status["duration_sec"] = "provided"

        manual_required_supplied = isinstance(llm.get("manual_required"), bool)
        if manual_required_supplied:
            task["manual_required"] = llm["manual_required"]

        raw_manual_duration = _as_int(llm.get("manual_duration_sec"))
        manual_duration = _coerce_duration(raw_manual_duration)
        if manual_duration is not None:
            task["manual_duration_sec"] = min(manual_duration, task["duration_sec"])
            field_status["manual_duration_sec"] = "provided"

        segments_supplied = isinstance(llm.get("manual_segments"), list)
        if segments_supplied:
            task["manual_segments"] = _coerce_segments(
                llm["manual_segments"], task["duration_sec"]
            )
        elif duration is not None:
            # A shorter LLM duration can invalidate deterministic end-of-task
            # operator segments. Reconcile inherited segments against the new
            # task boundary instead of leaking an invalid task downstream.
            task["manual_segments"] = _coerce_segments(
                task.get("manual_segments", []), task["duration_sec"]
            )

        if not task["manual_required"]:
            # `manual_required=false` is authoritative even when the baseline
            # contained manual work. Zero and clear all associated fields.
            task["manual_duration_sec"] = 0
            task["manual_segments"] = []
            if manual_required_supplied or raw_manual_duration == 0:
                field_status["manual_duration_sec"] = "provided"
        else:
            # Keep the business invariant required by the scheduler. This also
            # handles an LLM changing a pure-device baseline to manual work
            # without supplying a duration.
            if task.get("manual_duration_sec", 0) <= 0:
                segment_total = sum(
                    segment["duration_sec"] for segment in task.get("manual_segments", [])
                )
                task["manual_duration_sec"] = segment_total or min(30, task["duration_sec"])
                field_status["manual_duration_sec"] = "inferred"
            else:
                task["manual_duration_sec"] = min(
                    task["manual_duration_sec"], task["duration_sec"]
                )

        if isinstance(llm.get("confidence"), (int, float)):
            value = llm["confidence"]
            if isinstance(value, bool):
                value = None
            if value is not None:
                task["confidence"] = max(0.0, min(1.0, float(value)))

        if isinstance(llm.get("interruptible"), bool):
            task["interruptible"] = llm["interruptible"]

        action = llm.get("action")
        if isinstance(action, str) and action.strip():
            task["action"] = action.strip()[:200]

        # Reconcile resource_type with the (possibly overlaid) requirements so
        # the schema's allOf invariant (device/hybrid require device_requirement;
        # manual/wait forbid it) always holds.
        task["resource_type"] = _resource_type(task)

        task["field_status"] = field_status
        task["dish_id"] = recipe["recipe_id"]
        task["source_step_index"] = index
        return task


def _index_llm_items(items: list[Any], step_count: int) -> dict[int, dict[str, Any]]:
    """Map model output to step index by explicit index or list position."""
    indexed: dict[int, dict[str, Any]] = {}
    for position, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        explicit = _as_int(item.get("source_step_index") or item.get("step_index"))
        key = explicit if explicit is not None and 0 <= explicit < step_count else position
        indexed.setdefault(key, item)
    return indexed


def _resolve_predecessors(raw: Any, index: int, tasks: list[dict[str, Any]]) -> list[str]:
    """Keep only predecessor references that name a real earlier task."""
    if not isinstance(raw, list):
        return [tasks[index - 1]["task_id"]] if index > 0 else []
    known = {task["source_step_index"]: task["task_id"] for task in tasks}
    resolved: list[str] = []
    for reference in raw:
        step_index = _as_int(reference)
        if step_index is None or step_index >= index:
            continue
        if step_index in known:
            resolved.append(known[step_index])
    # De-duplicate while preserving order.
    seen: set[str] = set()
    ordered = [task_id for task_id in resolved if not (task_id in seen or seen.add(task_id))]
    return ordered


def _coerce_segments(segments: list[Any], duration_sec: int) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        offset = _as_int(segment.get("offset_sec"))
        length = _as_int(segment.get("duration_sec"))
        action = segment.get("action")
        if offset is None or offset < 0 or length is None or length <= 0:
            continue
        if offset + length > duration_sec:
            continue
        result.append(
            {
                "offset_sec": offset,
                "duration_sec": length,
                "action": (action if isinstance(action, str) and action.strip() else "操作")[:200],
            }
        )
    return result


def _resource_type(task: dict[str, Any]) -> str:
    if task.get("device_requirement") is not None:
        return "hybrid" if task.get("manual_required") else "device"
    return "manual"
