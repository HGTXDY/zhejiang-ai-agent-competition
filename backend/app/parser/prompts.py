"""Versioned prompt templates for LLM-based recipe structuring.

Keeping the prompts as data (not inline strings) makes them reviewable and
testable, and gives the deliverable a single source of truth for the "Prompt
策略" section of the technical proposal. See `docs/technical/PROMPT_STRATEGY.md`.
"""
from __future__ import annotations

import json
from typing import Any

# The seven schedulable device types, kept in sync with task.schema.json.
DEVICE_TYPES = [
    "range_hood",
    "stove",
    "steamer",
    "oven",
    "refrigerator",
    "dishwasher",
    "water_purifier",
]

SYSTEM_PROMPT = """你是方太智能厨房的菜谱结构化解析器。你的任务是把中文自然语言烹饪步骤转换为可调度的结构化任务。

只输出一个 JSON 数组，不要输出任何解释、注释或 Markdown 代码块。数组的每个元素是一个任务对象，字段如下：

- "source_step_index": 整数，对应输入 steps_text 的下标（从 0 开始）。
- "action": 该步骤的简要动作描述（原文或精炼后的短句，最多 200 字）。
- "device_type": 该步骤使用的设备，只能是以下之一，没有设备则为 null：
  range_hood（烟机）、stove（灶具）、steamer（蒸箱）、oven（烤箱）、refrigerator（冰箱）、dishwasher（洗碗机）、water_purifier（净水机）。
- "mode": 设备工作模式（如普通蒸 normal_steam、空气炸 air_fry、冷藏 chill、解冻 thaw），无法判断则为 null。蒸烤箱一体设备必须根据步骤中的模式信号（普通蒸/上下火/空气炸等）判断是蒸还是烤。
- "temperature_c": 温度（整数，摄氏度），步骤未写温度则为 null。冷藏/冷冻/解冻在未写明温度时按常识推断（冷藏约 4、冷冻约 -18、解冻约 4）。
- "duration_sec": 该步骤持续时间（整数，秒）。小时 ×3600，分钟 ×60。步骤未写时间则为 null。
- "manual_required": 布尔值，该步骤是否需要人工介入（切、洗、搅拌、翻炒、放入、取出等动作都需要人工）。
- "manual_duration_sec": 人工操作持续时间（整数，秒），不需要人工则为 0。
- "manual_segments": 数组，人工操作的起止片段；每个元素为 {"offset_sec": 整数, "duration_sec": 整数, "action": 字符串}。不需要人工则为空数组。
- "predecessors": 字符串数组，本步骤依赖的前置任务（用步骤下标对应的 task 序号表达）；默认顺序依赖上一步。
- "interruptible": 布尔值，是否可中断。
- "confidence": 0 到 1 的小数，你对本次提取的置信度。

严格要求：
1. 设备识别只看七类设备，不要把"锅/炒锅"误判为别的设备（锅、炒锅、炖锅、汤锅、砂锅都属于 stove 灶具）。
2. "蒸"默认属于蒸箱 steamer，"烤/烘/炸"默认属于烤箱 oven；"炒/煎/炸/煮/炖/焯"属于灶具 stove；"冷藏/冷冻/解冻"属于冰箱 refrigerator。
3. 温度和时间必须从文本中精确提取，不要凭空编造；文本没有就填 null。
4. 每个步骤都要对应一个元素，元素个数等于 steps_text 的长度，顺序一致。"""


def build_user_prompt(recipe: dict[str, Any]) -> str:
    """Serialize one V1 recipe into the extraction prompt.

    Only the fields the model needs are sent: the recipe id, name and the
    natural-language steps. Ingredients are intentionally omitted — scheduling
    is driven by steps, not by the ingredient list.
    """
    steps = recipe.get("steps_text", [])
    return (
        f"菜名：{recipe.get('name', '')}\n"
        f"菜谱ID：{recipe.get('recipe_id', '')}\n"
        "烹饪步骤（按顺序，下标从 0 开始）：\n"
        + "\n".join(f"[{index}] {text}" for index, text in enumerate(steps))
        + "\n\n请输出 JSON 数组。"
    )


def as_system_prompt() -> str:
    """Return the system prompt (used by tests to assert the contract is stable)."""
    return SYSTEM_PROMPT


def encode_recipe(recipe: dict[str, Any]) -> str:
    """Lossless JSON serialization kept for parity checks in the test suite."""
    return json.dumps(recipe, ensure_ascii=False)
