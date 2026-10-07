"""Lightweight orchestration helpers for the user-facing cooking agent.

The language model may help understand wording, but catalog matching and event
construction stay deterministic so the agent cannot invent recipes or unsafe
scheduler inputs.
"""
from __future__ import annotations

import re
from typing import Any

from app.catalog import list_recipe_summaries

_CN_NUMBERS = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
_DEVICE_FIELDS = {"灶": "stove_count", "灶眼": "stove_count", "蒸箱": "steamer_count", "烤箱": "oven_count"}


def _number(value: str) -> int | None:
    if value.isdigit():
        return int(value)
    return _CN_NUMBERS.get(value)


def _extract_time(message: str) -> str | None:
    match = re.search(r"(?:上午|早上|中午|下午|晚上|今晚)?\s*(\d{1,2})[:：](\d{2})", message)
    if match:
        hour, minute = int(match.group(1)), int(match.group(2))
        prefix = message[max(0, match.start() - 3):match.start()]
        if any(word in prefix for word in ("下午", "晚上", "今晚")) and hour < 12:
            hour += 12
        return f"{hour:02d}:{minute:02d}" if hour < 24 and minute < 60 else None
    match = re.search(r"(上午|早上|中午|下午|晚上|今晚)?\s*([一二两三四五六七八九十\d]{1,2})点(半|[一二三四五六七八九十\d]{1,2}分?)?", message)
    if not match:
        return None
    hour = _number(match.group(2))
    if hour is None:
        return None
    minute_text = match.group(3) or ""
    minute = 30 if minute_text == "半" else (_number(minute_text.rstrip("分")) or 0)
    if match.group(1) in {"下午", "晚上", "今晚"} and hour < 12:
        hour += 12
    if match.group(1) == "中午" and hour < 11:
        hour += 12
    return f"{hour:02d}:{minute:02d}" if hour < 24 and minute < 60 else None


def _extract_count(message: str, noun: str) -> int | None:
    patterns = [rf"([一二两三四五六七八九十\d]+)\s*(?:个|台|名)?{noun}", rf"{noun}\s*([一二两三四五六七八九十\d]+)"]
    for pattern in patterns:
        match = re.search(pattern, message)
        if match:
            return _number(match.group(1))
    return None


def _match_recipes(message: str) -> list[dict[str, str]]:
    catalog = list_recipe_summaries()["recipes"]
    matched = [recipe for recipe in catalog if recipe["name"] in message]
    unique: list[dict[str, str]] = []
    seen_names: set[str] = set()
    for recipe in matched:
        if recipe["name"] in seen_names:
            continue
        seen_names.add(recipe["name"])
        unique.append({"recipe_id": recipe["recipe_id"], "name": recipe["name"]})
    return unique[:5]


def interpret_plan(payload: dict[str, Any]) -> dict[str, Any]:
    message = str(payload.get("message") or "").strip()
    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    previous_recipes = context.get("recipes") if isinstance(context.get("recipes"), list) else []
    recipes = _match_recipes(message) or previous_recipes
    target_time = _extract_time(message) or context.get("target_time")
    operator_count = _extract_count(message, "人") or context.get("operator_count")
    devices = dict(context.get("devices") or {})
    for noun, field in _DEVICE_FIELDS.items():
        count = _extract_count(message, noun)
        if count is not None:
            devices[field] = count
    # Natural phrases such as “一个灶” are covered above; preserve explicit zeros.
    missing: list[str] = []
    if not 3 <= len(recipes) <= 5:
        missing.append("recipes")
    if not target_time:
        missing.append("target_time")
    if not operator_count:
        missing.append("operator_count")
    for field in ("stove_count", "steamer_count", "oven_count"):
        if field not in devices:
            missing.append(field)
    draft = {"recipes": recipes, "target_time": target_time, "operator_count": operator_count, "devices": devices}
    labels = {
        "recipes": "请告诉我想做的 3～5 道菜（需来自菜谱库）",
        "target_time": "希望几点开饭？",
        "operator_count": "有几个人一起做饭？",
        "stove_count": "有几个可用灶眼？没有也可以说 0 个",
        "steamer_count": "有几台蒸箱？没有也可以说 0 台",
        "oven_count": "有几台烤箱？没有也可以说 0 台",
    }
    if missing:
        reply = "我已经记下现有信息。" + " ".join(labels[item] for item in missing[:2])
    else:
        reply = f"我理解了：{target_time} 开饭，{operator_count} 人操作，共 {len(recipes)} 道菜。请确认后生成计划。"
    return {
        "intent": "create_schedule",
        "reply": reply,
        "draft": draft,
        "missing_fields": missing,
        "unmatched_recipe_names": [],
        "ready_to_confirm": not missing,
        "tool_trace": [
            {"name": "match_recipes", "status": "completed", "label": f"已匹配 {len(recipes)} 道菜"},
            {"name": "read_kitchen", "status": "completed" if not any(item.endswith("_count") for item in missing) else "waiting", "label": "已读取厨房条件"},
            {"name": "validate_draft", "status": "completed" if not missing else "waiting", "label": "已检查规划信息"},
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
