"""Lightweight orchestration helpers for the user-facing cooking agent.

The language model may help understand wording, but catalog matching and event
construction stay deterministic so the agent cannot invent recipes or unsafe
scheduler inputs.
"""
from __future__ import annotations

import json
import re
from typing import Any

from app.agent_prompts import load_prompt, render_prompt
from app.catalog import list_recipe_summaries
from app.parser.adapter import ParsedTaskError
from app.parser.llm import LLMClient

_CN_NUMBERS = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
_DEVICE_COUNT_FIELDS = (
    "stove_count",
    "steamer_count",
    "oven_count",
    "refrigerator_count",
    "dishwasher_count",
    "range_hood_count",
    "water_purifier_count",
)


def _number(value: str) -> int | None:
    if value.isdigit():
        return int(value)
    return _CN_NUMBERS.get(value)


def _extract_json_object(text: str) -> dict[str, Any]:
    if not isinstance(text, str) or not text.strip():
        raise ParsedTaskError("Agent model returned an empty response")
    stripped = re.sub(r"```(?:json)?", "", text).strip()
    decoder = json.JSONDecoder()
    for index, character in enumerate(stripped):
        if character != "{":
            continue
        try:
            value, _ = decoder.raw_decode(stripped[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise ParsedTaskError("Agent model response contains no valid JSON object")


def _valid_count(value: Any, *, allow_zero: bool) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    minimum = 0 if allow_zero else 1
    return value if minimum <= value <= 20 else None


def _valid_time(value: Any) -> str | None:
    if not isinstance(value, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value):
        return None
    return value


def _catalog_index() -> tuple[list[dict[str, str]], dict[str, dict[str, str]], dict[str, list[dict[str, str]]]]:
    catalog = [
        {"recipe_id": str(item["recipe_id"]), "name": str(item["name"])}
        for item in list_recipe_summaries()["recipes"]
    ]
    by_name: dict[str, list[dict[str, str]]] = {}
    for item in catalog:
        by_name.setdefault(item["name"], []).append(item)
    return catalog, {item["recipe_id"]: item for item in catalog}, by_name


def _sanitize_recipes(
    value: Any,
    by_id: dict[str, dict[str, str]],
    by_name: dict[str, list[dict[str, str]]],
    *,
    rejected_names: list[str] | None = None,
) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    selected: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw in value:
        if not isinstance(raw, dict):
            continue
        recipe_id = str(raw.get("recipe_id") or "").strip()
        name = str(raw.get("name") or "").strip()
        if recipe_id:
            recipe = by_id.get(recipe_id)
        else:
            name_matches = by_name.get(name, [])
            recipe = name_matches[0] if len(name_matches) == 1 else None
        if recipe is None:
            if rejected_names is not None and (name or recipe_id):
                rejected_names.append((name or recipe_id)[:80])
            continue
        if recipe["recipe_id"] in seen:
            continue
        seen.add(recipe["recipe_id"])
        selected.append(dict(recipe))
    return selected[:5]


def _missing_fields(draft: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    if not 3 <= len(draft["recipes"]) <= 5:
        missing.append("recipes")
    if not draft["target_time"]:
        missing.append("target_time")
    if not draft["operator_count"]:
        missing.append("operator_count")
    for field in _DEVICE_COUNT_FIELDS:
        if field not in draft["devices"]:
            missing.append(field)
    return missing


def _safe_reply(value: Any, draft: dict[str, Any], missing: list[str], unmatched_names: list[str]) -> str:
    labels = {
        "recipes": "请告诉我想做的 3～5 道菜（需来自菜谱库）。",
        "target_time": "希望几点开饭？",
        "operator_count": "有几个人一起做饭？",
        "stove_count": "有几个可用灶眼？没有也可以说 0 个。",
        "steamer_count": "有几台蒸箱？没有也可以说 0 台。",
        "oven_count": "有几台烤箱？没有也可以说 0 台。",
        "refrigerator_count": "有几台冰箱？没有也可以说 0 台。",
        "dishwasher_count": "有几台洗碗机？没有也可以说 0 台。",
        "range_hood_count": "有几台烟机？没有也可以说 0 台。",
        "water_purifier_count": "有几台净水机或净咖一体机？没有也可以说 0 台。",
    }
    if unmatched_names:
        names = "、".join(unmatched_names[:5])
        return f"以下菜品暂时无法从官方菜谱库中唯一确认：{names}。请重新选择，或补充能唯一确认的菜品信息。"
    if missing:
        return "我已经记下现有信息。" + "".join(labels[item] for item in missing[:2])
    if isinstance(value, str) and 1 <= len(value.strip()) <= 300:
        return value.strip()
    return f"我理解了：{draft['target_time']} 开饭，{draft['operator_count']} 人操作，共 {len(draft['recipes'])} 道菜。请确认信息后进入菜谱步骤确认。"


def interpret_plan(payload: dict[str, Any], *, client: LLMClient) -> dict[str, Any]:
    """Use the configured model for dialogue understanding, then fail closed through catalog validation."""
    message = str(payload.get("message") or "").strip()
    if not message:
        raise ValueError("message 不能为空")
    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    catalog, by_id, by_name = _catalog_index()
    user_prompt = render_prompt(
        "user.txt",
        context_json=json.dumps(context, ensure_ascii=False, separators=(",", ":")),
        catalog_json=json.dumps(catalog, ensure_ascii=False, separators=(",", ":")),
        user_message=message,
    )
    raw = _extract_json_object(client.complete(load_prompt("system.txt"), user_prompt))
    raw_draft = raw.get("draft") if isinstance(raw.get("draft"), dict) else {}

    previous_recipes = _sanitize_recipes(context.get("recipes"), by_id, by_name)
    rejected_recipe_names: list[str] = []
    recipes = _sanitize_recipes(
        raw_draft.get("recipes"),
        by_id,
        by_name,
        rejected_names=rejected_recipe_names,
    ) or previous_recipes
    target_time = _valid_time(raw_draft.get("target_time")) or _valid_time(context.get("target_time"))
    operator_count = _valid_count(raw_draft.get("operator_count"), allow_zero=False) or _valid_count(context.get("operator_count"), allow_zero=False)
    previous_devices = context.get("devices") if isinstance(context.get("devices"), dict) else {}
    raw_devices = raw_draft.get("devices") if isinstance(raw_draft.get("devices"), dict) else {}
    devices: dict[str, int] = {}
    for field in _DEVICE_COUNT_FIELDS:
        count = _valid_count(raw_devices.get(field), allow_zero=True)
        if count is None:
            count = _valid_count(previous_devices.get(field), allow_zero=True)
        if count is not None:
            devices[field] = count

    draft = {"recipes": recipes, "target_time": target_time, "operator_count": operator_count, "devices": devices}
    missing = _missing_fields(draft)
    unmatched = raw.get("unmatched_recipe_names")
    model_unmatched = [str(item).strip()[:80] for item in unmatched if isinstance(item, str) and item.strip()] if isinstance(unmatched, list) else []
    unmatched_names = list(dict.fromkeys([*model_unmatched, *rejected_recipe_names]))[:5]
    blocked = bool(missing or unmatched_names)
    return {
        "intent": "create_schedule",
        "reply": _safe_reply(raw.get("reply"), draft, missing, unmatched_names),
        "draft": draft,
        "missing_fields": missing,
        "unmatched_recipe_names": unmatched_names,
        "ready_to_confirm": not blocked,
        "tool_trace": [
            {"name": "understand_request", "status": "completed", "label": "大模型已理解本轮需求"},
            {"name": "match_recipes", "status": "completed", "label": f"菜谱库已确认 {len(recipes)} 道菜"},
            {"name": "validate_draft", "status": "waiting" if blocked else "completed", "label": "规划字段等待补充" if blocked else "规划字段校验通过"},
        ],
    }


def interpret_command(payload: dict[str, Any]) -> dict[str, Any]:
    message = str(payload.get("message") or "").strip()
    tasks = payload.get("tasks") if isinstance(payload.get("tasks"), list) else []
    recipes = payload.get("recipes") if isinstance(payload.get("recipes"), list) else []
    def mentioned(task: dict[str, Any]) -> bool:
        labels = [str(task.get("action", "")), str(task.get("dish_name", ""))]
        return any(label and (label in message or any(label[index:index + 2] in message for index in range(max(0, len(label) - 1)))) for label in labels)
    selected = next((task for task in tasks if mentioned(task)), None)
    if any(word in message for word in ("加一道", "加菜", "再做")):
        recipe = next((item for item in recipes if str(item.get("name", "")) in message), None)
        return {"intent": "add_dish", "reply": "已识别临时加菜。" if recipe else "你想临时加哪一道菜？", "recipe_id": recipe.get("recipe_id") if recipe else None, "ready": bool(recipe)}
    if any(word in message for word in ("坏了", "不可用", "故障")):
        device = next((value for key, value in (("蒸箱", "steamer_1"), ("烤箱", "oven_1"), ("灶", "stove_1")) if key in message), None)
        return {"intent": "device_unavailable", "reply": "已识别设备异常，将重新安排。" if device else "请说明是哪台设备不可用。", "device_id": device, "ready": bool(device)}
    if any(word in message for word in ("慢了", "延迟", "晚了")):
        minute = re.search(r"([一二两三四五六七八九十\d]+)\s*分钟", message)
        delay_minutes = _number(minute.group(1)) if minute else 1
        return {"intent": "task_delayed", "reply": "已识别步骤延迟，将重新计算后续安排。" if selected else "请点选或说出发生延迟的菜/步骤。", "task_id": selected.get("task_id") if selected else None, "delay_sec": (delay_minutes or 1) * 60, "ready": bool(selected)}
    if any(word in message for word in ("完成", "做好了", "已经好了")):
        return {"intent": "task_completed", "reply": "已识别步骤完成。" if selected else "请点选或说出已经完成的菜/步骤。", "task_id": selected.get("task_id") if selected else None, "ready": bool(selected)}
    if any(word in message for word in ("开始", "做上了", "蒸上了", "烤上了")):
        return {"intent": "task_started", "reply": "已识别步骤开始。" if selected else "请点选或说出已经开始的菜/步骤。", "task_id": selected.get("task_id") if selected else None, "ready": bool(selected)}
    return {"intent": "unknown", "reply": "我可以处理：步骤开始/完成/延迟、设备故障或临时加菜。", "ready": False}
