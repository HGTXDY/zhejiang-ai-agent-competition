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

import json
import os
import re
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

_MIN_TEMPERATURE_C = -50
_MAX_TEMPERATURE_C = 500
_MAX_DURATION_SEC = 86400


class LLMClient(Protocol):
    def complete(self, system: str, user: str) -> str:
        """Return the model's text for a system/user message pair."""


class OpenAICompatClient:
    """Minimal OpenAI-compatible chat-completions client (no SDK dependency)."""

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
        try:
            with urllib.request.urlopen(request, timeout=self._timeout_sec) as response:
                body = json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            raise ParsedTaskError(f"LLM request failed: {error}") from error
        try:
            return body["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as error:
            raise ParsedTaskError("LLM response is missing choices[0].message.content") from error


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
        self._fallback = fallback or DeterministicParserAdapter(strict=strict)

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
        if device_type in DEVICE_TYPES:
            requirement = dict(baseline.get("device_requirement") or {})
            requirement["device_type"] = device_type
            # A device inferred only by the LLM has no deterministic
            # requirement to inherit. Keep the merged object schema-valid and
            # schedulable by using the V1 single-capacity default.
            requirement.setdefault("capacity_units", 1)
            field_status["device_type"] = "provided"
            task["device_requirement"] = requirement

        mode = llm.get("mode")
        requirement = task.get("device_requirement")
        if requirement is not None and isinstance(mode, str) and mode.strip():
            requirement["mode"] = mode.strip()
            field_status["device_mode"] = "provided"

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
