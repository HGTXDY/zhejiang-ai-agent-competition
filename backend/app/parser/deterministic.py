"""Deterministic rule-based recipe parser.

This module implements a provider-independent, reproducible natural-language
parser that converts Chinese cooking steps into V1 scheduling tasks. It is the
baseline backend for the `POST /recipes/parse` endpoint and the official-100
recipe batch pipeline, and it satisfies NFR-104 (same input -> same output)
by construction: there is no randomness and no external service.

The parser resolves what it can with explicit provenance in `field_status`
(`provided` / `inferred` / `defaulted`). Fields it cannot resolve in strict
mode are marked `missing`, which `RecipeParser` rejects so they never reach the
scheduler. Non-strict mode falls back to documented per-device defaults so the
full pipeline still runs end-to-end over low-annotation recipes.

An LLM provider can replace this adapter by implementing `ParserAdapter` with
the same input/output contract; the tables here double as the review notes for
the field-mapping decisions recorded in `data/official/MAPPING_NOTES.md`.
"""
from __future__ import annotations

import re
from typing import Any

# Ordered device nouns: explicit equipment beats generic cooking verbs.
_DEVICE_NOUNS: list[tuple[str, str]] = [
    ("烤箱|烤盘|烘焙(?!纸)", "oven"),
    ("蒸箱|蒸锅|蒸笼", "steamer"),
    ("洗碗机", "dishwasher"),
    ("冰箱|冷藏|冷冻|解冻", "refrigerator"),
    ("烟机|抽油烟机", "range_hood"),
    ("净咖|咖啡机|即热|净水", "water_purifier"),
    ("锅|炒锅|平底锅|炖锅|汤锅|砂锅|灶", "stove"),
]

# Cooking-verb fallback, only trusted when the step also carries a duration or
# temperature so noun phrases like "炒饭" (fried rice) do not become devices.
_DEVICE_VERBS: list[tuple[str, str]] = [
    ("蒸", "steamer"),
    ("烤", "oven"),
    ("煎|炒|炸|烧|煮|炖|焖|煲|烙|煸|爆|焯", "stove"),
]

# Combo steam-oven equipment (蒸烤箱 / 蒸烤一体机 / 方太智能烹饪设备) can steam
# or bake depending on the selected mode. These aliases must be resolved by mode,
# not by the bare "烤箱" noun, before the generic noun loop runs.
_COMBO_DEVICE = re.compile(r"蒸烤|蒸烤一体|烹饪机|智能烹饪")

# Explicit mode signals only (no bare "蒸"/"烤"), mirroring _MODE_TABLE so a step
# that merely names "蒸烤箱" is not auto-attributed to either side.
_STEAM_MODE_SIGNAL = re.compile(r"普通蒸|常规蒸|鲜嫩蒸|嫩蒸|脱脂蒸|多层蒸")
_OVEN_MODE_SIGNAL = re.compile(
    r"空气炸|气炸|上下火|全开烤|全开|鼓风烤|热风|风烤|顶部烤|顶部|加湿烤|加湿|"
    r"环风烤|环风|脱脂烤|脱脂|蔬果干|风干|发酵|醒发|烘焙|烘烤"
)
# A steam oven draws water from its tank; refilling it is a documented inference
# that the step steams rather than bakes when no explicit mode is spelled out.
_WATER_TANK_SIGNAL = re.compile(r"水箱|加满水")

_MODE_TABLE: dict[str, list[tuple[str, str]]] = {
    "oven": [
        ("空气炸|气炸", "air_fry"),
        ("上下火", "upper_lower_heat"),
        ("全开烤|全开", "full_grill"),
        ("鼓风烤|热风|风烤", "convection"),
        ("顶部烤|顶部", "top_heat"),
        ("加湿烤|加湿", "humid_bake"),
        ("环风烤|环风", "circulating"),
        ("脱脂烤|脱脂", "defat_roast"),
        ("蔬果干|风干", "dehydrate"),
        ("发酵|醒发", "proof"),
        ("烘焙|烘烤|烤", "bake"),
    ],
    "steamer": [
        ("鲜嫩蒸|嫩蒸", "gentle_steam"),
        ("脱脂蒸", "defat_steam"),
        ("多层蒸", "multi_layer_steam"),
        ("普通蒸|常规蒸|蒸", "normal_steam"),
    ],
    "stove": [
        ("煮沸|烧开|焯水|焯", "boil"),
        ("大火|旺火|爆炒|爆", "high_heat"),
        ("中火", "medium_heat"),
        ("小火|文火", "low_heat"),
        ("煎", "pan_fry"),
        ("炸", "deep_fry"),
        ("炖|焖|煲|卤", "stew"),
        ("炒|翻炒|拌炒", "stir_fry"),
        ("煮", "simmer"),
    ],
    "refrigerator": [
        ("解冻", "thaw"),
        ("冷冻", "freeze"),
        ("冷藏", "chill"),
    ],
    "dishwasher": [
        ("母婴洗", "baby_care"),
        ("超净洗", "deep_clean"),
        ("日常洗", "daily"),
    ],
    "range_hood": [
        ("强挡|强档", "high"),
        ("弱挡|弱档", "low"),
    ],
    "water_purifier": [
        ("浓缩|美式|拿铁|卡布奇诺|澳白|咖啡", "coffee"),
        ("即热|出水", "instant_heat"),
    ],
}

_DEFAULT_MODE: dict[str, str] = {
    "oven": "bake",
    "steamer": "normal_steam",
    "stove": "simmer",
    "refrigerator": "chill",
    "dishwasher": "daily",
    "range_hood": "high",
    "water_purifier": "instant_heat",
}

_DEFAULT_TEMPERATURE_C: dict[str, int] = {
    "oven": 180,
    "steamer": 100,
    "stove": 100,
    "water_purifier": 60,
}
_REFRIGERATOR_DEFAULT_TEMPERATURE_C: dict[str, int] = {
    "freeze": -18,
    "chill": 4,
    "thaw": 4,
}

# Fallback durations when a step carries no explicit time. Device cooking times
# are too recipe-specific to invent, so strict mode marks them missing instead.
_DEFAULT_DURATION_SEC: dict[str, int] = {
    "oven": 900,
    "steamer": 480,
    "stove": 300,
    "refrigerator": 3600,
    "dishwasher": 1800,
    "range_hood": 60,
    "water_purifier": 60,
}
_MANUAL_DEFAULT_DURATION_SEC = 120
_WAIT_DEFAULT_DURATION_SEC = 600

_BEGIN_ACTIONS = re.compile(r"放入|倒入|加入|撒|淋|刷|抹|铺|摆|码|盖|封|塞入|挤入")
_END_ACTIONS = re.compile(r"取出|捞出|盛出|装盘|装碗|翻面|关火")
_MANUAL_ACTIONS = re.compile(r"切|剁|洗|拌|搅|翻|放|取|捞|盛|装|封|裹|刷|抹|搓|揉|擀|包|塞|倒|撒|淋|压|挑|削|剥|打|挤|混|抓|码|铺|摆|盖")
_WAIT_KEYWORDS = re.compile(r"静置|醒发|发酵|松弛|饧|浸泡|泡发|泡软|晾")

_TEMPERATURE = re.compile(r"(\d+)\s*(?:℃|°C|°c|摄氏度|度)")
_DURATION_UNIT = re.compile(r"(\d+(?:\.\d+)?)\s*(?:个\s*)?(小时|分钟|秒|hr|h|min)", re.I)
_HALF_MINUTE = re.compile(r"半分钟")
_HALF_HOUR = re.compile(r"半(?:个)?小时")

# Split only an explicitly timed storage/rest phase preceded by real preparation.
# This avoids treating every long cooking task (e.g. a two-hour braise) as advance
# preparation. The split remains a chain within the same original recipe step.
_TIMED_HOLD = re.compile(
    r"(?P<action>冷冻|冷藏|腌制|腌渍|浸泡|泡发|静置|醒发|发酵)"
    r"(?P<between>\s*(?:(?:约|大约|至少|需)\s*)?)"
    r"(?P<duration>(?:\d+(?:\.\d+)?\s*(?:个\s*)?(?:小时|分钟|hr|h|min)|半(?:个)?小时))",
    re.I,
)
_DEVICE_ENTRY = re.compile(r"(?:放入?|放进|置于|送入|进|移入)\s*(?:冰箱|冷藏室|冷冻室)\s*$")
_HOLD_CONDITION = re.compile(r"(?:常温|室温|冷水|温水)\s*$")
_PREP_ACTION = re.compile(r"洗|切|剁|拌|搅|揉|抓|裹|包|刷|抹|擀|剥|压|混合|加|剪|捏|过筛|铺|摆|装")
# An explicit post-hold action must not execute during the holding interval.
_AFTER_HOLD = re.compile(r"[，,。]\s*(?=取出|捞出|挤干|沥干|切|洗|拌|搅|摆|装盘)")


def extract_duration_sec(text: str) -> int | None:
    """Sum explicit time spans in a step, or None when none are present."""
    total = 0
    found = False
    if _HALF_MINUTE.search(text):
        total += 30
        found = True
    if _HALF_HOUR.search(text):
        total += 1800
        found = True
    for value, unit in _DURATION_UNIT.findall(text):
        seconds = float(value) * {"小时": 3600, "h": 3600, "hr": 3600,
                                  "分钟": 60, "min": 60, "秒": 1}[unit.lower()]
        total += int(round(seconds))
        found = True
    return total if found else None


def _split_timed_hold(text: str) -> list[tuple[str, bool]] | None:
    """Separate hands-on preparation from a timed hold, conservatively.

    The source can contain manual preparation, an explicit rest/storage interval,
    and sometimes a follow-up manual action. If another timed operation occurs
    after the interval, leave the step intact rather than invent a sequence.
    Returns (action, force_wait) pairs, or None if the split is uncertain.
    """
    match = _TIMED_HOLD.search(text)
    if match is None:
        return None

    before = text[:match.start("action")]
    entry = _DEVICE_ENTRY.search(before)
    condition = _HOLD_CONDITION.search(before) if not entry else None
    if entry or condition:
        boundary = (entry or condition).start()
        before = text[:boundary]
        hold_start = boundary
    else:
        hold_start = match.start("action")
    before = before.strip(" ，,。；; ")
    if not before or not _PREP_ACTION.search(before):
        return None

    # Do not mistake an unrelated later duration for the hold's duration.
    hold_end = match.end("duration")
    after_duration = text[hold_end:]
    if extract_duration_sec(after_duration) is not None:
        return None

    hold_text = text[hold_start:]
    followup = _AFTER_HOLD.search(hold_text, match.end("duration") - hold_start)
    if followup:
        followup_text = hold_text[followup.end():].strip(" ，,。；; ")
        hold_text = hold_text[:followup.start()].strip(" ，,。；; ")
        if followup_text and _PREP_ACTION.search(followup_text):
            return [(before, False), (hold_text, True), (followup_text, False)]

    hold_text = hold_text.strip(" ，,。；; ")
    return [(before, False), (hold_text, True)] if hold_text else None


def extract_temperature_c(text: str) -> int | None:
    match = _TEMPERATURE.search(text)
    return int(match.group(1)) if match else None


def _detect_combo_device_type(text: str) -> str | None:
    """Resolve a combo steam-oven step to `steamer`/`oven` by its explicit mode.

    Returns `None` when the step is not combo equipment, or when it is combo
    equipment but carries no steam/oven signal (the machine auto-selects the mode
    and the step text cannot recover it).
    """
    if not _COMBO_DEVICE.search(text):
        return None
    if _STEAM_MODE_SIGNAL.search(text):
        return "steamer"
    if _OVEN_MODE_SIGNAL.search(text):
        return "oven"
    if _WATER_TANK_SIGNAL.search(text):
        return "steamer"
    return None


def detect_device_type(text: str) -> str | None:
    """Return the V1 device_type for a step, or None for manual/wait steps."""
    combo_type = _detect_combo_device_type(text)
    if combo_type is not None:
        return combo_type
    if _COMBO_DEVICE.search(text):
        # Combo equipment with no recoverable mode: don't guess steam vs oven.
        return None
    for pattern, device_type in _DEVICE_NOUNS:
        if re.search(pattern, text):
            return device_type
    has_signal = extract_duration_sec(text) is not None or extract_temperature_c(text) is not None
    if has_signal:
        for pattern, device_type in _DEVICE_VERBS:
            if re.search(pattern, text):
                return device_type
    return None


def detect_mode(text: str, device_type: str) -> str:
    for pattern, mode in _MODE_TABLE.get(device_type, []):
        if re.search(pattern, text):
            return mode
    return _DEFAULT_MODE[device_type]


def _is_wait(text: str) -> bool:
    return bool(_WAIT_KEYWORDS.search(text))


def _manual_segments(text: str, duration_sec: int) -> list[dict[str, Any]]:
    """Return schema-valid manual segments for a step that needs operator help.

    A begin action (putting food into a device) lands at the start and an end
    action (taking it out) at the finish. Short tasks collapse to one segment so
    offsets never exceed the task duration.
    """
    begin = bool(_BEGIN_ACTIONS.search(text))
    end = bool(_END_ACTIONS.search(text))
    if duration_sec <= 30:
        if begin or end:
            return [{"offset_sec": 0, "duration_sec": duration_sec, "action": text[:60]}]
        return []
    segments: list[dict[str, Any]] = []
    if begin:
        segments.append({"offset_sec": 0, "duration_sec": 30, "action": text[:60]})
    if end:
        segments.append({"offset_sec": max(30, duration_sec - 30), "duration_sec": 30, "action": text[:60]})
    if not segments:
        segments.append({"offset_sec": 0, "duration_sec": 30, "action": text[:60]})
    return segments


def default_device_config(operator_count: int = 1) -> dict[str, Any]:
    """Canonical device_config whose capabilities cover every mode this parser emits.

    This is the pairing used by the parse -> schedule batch loop so parsed tasks
    always find a compatible device instance.
    """
    device_specs: list[dict[str, Any]] = [
        {"device_id": "stove_burner_1", "device_type": "stove", "capacity_units": 1,
         "temperature_min_c": 60, "temperature_max_c": 250},
        {"device_id": "stove_burner_2", "device_type": "stove", "capacity_units": 1,
         "temperature_min_c": 60, "temperature_max_c": 250},
        {"device_id": "steamer_1", "device_type": "steamer", "capacity_units": 2,
         "temperature_min_c": 30, "temperature_max_c": 120},
        {"device_id": "oven_1", "device_type": "oven", "capacity_units": 2,
         "temperature_min_c": 30, "temperature_max_c": 250},
        {"device_id": "refrigerator_1", "device_type": "refrigerator", "capacity_units": 3,
         # Covers both official refrigerator ranges: 冷藏 0~10℃ and 冷冻 -24~-15℃.
         "temperature_min_c": -24, "temperature_max_c": 10},
        {"device_id": "dishwasher_1", "device_type": "dishwasher", "capacity_units": 1,
         "temperature_min_c": None, "temperature_max_c": None},
        {"device_id": "range_hood_1", "device_type": "range_hood", "capacity_units": 1,
         "temperature_min_c": None, "temperature_max_c": None},
        {"device_id": "water_purifier_1", "device_type": "water_purifier", "capacity_units": 1,
         "temperature_min_c": 0, "temperature_max_c": 98},
    ]
    devices = []
    for spec in device_specs:
        devices.append(
            {
                "device_id": spec["device_id"],
                "device_type": spec["device_type"],
                "capacity_units": spec["capacity_units"],
                "capabilities": {
                    "modes": [mode for _, mode in _MODE_TABLE[spec["device_type"]]],
                    "temperature_min_c": spec["temperature_min_c"],
                    "temperature_max_c": spec["temperature_max_c"],
                },
                "available": True,
            }
        )
    return {"schema_version": "1.0", "operator_count": operator_count, "devices": devices}


class DeterministicParserAdapter:
    """Deterministic `ParserAdapter` converting one recipe into V1 tasks."""

    provider = "deterministic"

    def __init__(self, *, strict: bool = False, split_compound: bool = True) -> None:
        self.strict = strict
        self.split_compound = split_compound

    def parse(self, recipe: dict[str, Any]) -> list[dict[str, Any]]:
        recipe_id = recipe["recipe_id"]
        tasks: list[dict[str, Any]] = []
        for index, text in enumerate(recipe["steps_text"]):
            segments = _split_timed_hold(text) if self.split_compound else None
            if segments is None:
                tasks.append(self._parse_step(recipe_id, index, text))
                continue
            for position, (action, force_wait) in enumerate(segments):
                # Keep the original step ID for its final task; earlier subtasks
                # get stable suffixes, preserving downstream step references.
                suffix = "" if position == len(segments) - 1 else ("_prep" if position == 0 else "_hold")
                tasks.append(
                    self._parse_step(
                        recipe_id, index, action, suffix=suffix, force_wait=force_wait,
                        # '取出冰箱的面团再擀开' uses no fridge time; it is
                        # manual work, not a second refrigerator occupancy.
                        force_manual=position == 0 and bool(re.search(r"(?:取出冰箱|从冰箱|冰箱的)", action))
                        and not bool(re.search(r"冷藏|冷冻|解冻|放入冰箱|放冰箱", action)),
                    )
                )
        for index, task in enumerate(tasks):
            if index > 0:
                task["predecessors"] = [tasks[index - 1]["task_id"]]
        return tasks

    def _parse_step(
        self, recipe_id: str, index: int, text: str, *, suffix: str = "", force_wait: bool = False,
        force_manual: bool = False,
    ) -> dict[str, Any]:
        task_id = f"{recipe_id}_{index:02d}{suffix}"
        duration = extract_duration_sec(text)
        device_type = None if force_manual else detect_device_type(text)
        is_wait = device_type is None and not force_manual and (force_wait or _is_wait(text))

        base: dict[str, Any] = {
            "schema_version": "1.0",
            "task_id": task_id,
            "dish_id": recipe_id,
            "action": text[:200],
            "predecessors": [],
            "interruptible": False,
            "confidence": None,
            "source_step_index": index,
            "field_status": {},
        }

        if is_wait:
            resolved_duration = duration if duration is not None else _WAIT_DEFAULT_DURATION_SEC
            base.update(
                resource_type="wait",
                duration_sec=resolved_duration,
                manual_required=False,
                manual_duration_sec=0,
                field_status={
                    "duration_sec": "provided" if duration is not None else "defaulted",
                    "device_type": "not_applicable",
                    "device_mode": "not_applicable",
                    "temperature_c": "not_applicable",
                    "manual_duration_sec": "not_applicable",
                },
            )
            return base

        if device_type is None:
            # Manual preparation step (no equipment).
            resolved_duration = duration if duration is not None else _MANUAL_DEFAULT_DURATION_SEC
            base.update(
                resource_type="manual",
                duration_sec=resolved_duration,
                manual_required=True,
                manual_duration_sec=resolved_duration,
                field_status={
                    "duration_sec": "provided" if duration is not None else "defaulted",
                    "device_type": "not_applicable",
                    "device_mode": "not_applicable",
                    "temperature_c": "not_applicable",
                    "manual_duration_sec": "provided" if duration is not None else "defaulted",
                },
            )
            return base

        # Device / hybrid step.
        if duration is None and self.strict:
            base.update(
                resource_type="device",
                duration_sec=1,  # placeholder; rejected downstream via missing status
                manual_required=False,
                manual_duration_sec=0,
                device_requirement={
                    "device_type": device_type,
                    "mode": detect_mode(text, device_type),
                    "temperature_c": extract_temperature_c(text),
                    "capacity_units": 1,
                },
                field_status={
                    "duration_sec": "missing",
                    "device_type": "provided",
                    "device_mode": "provided",
                    "temperature_c": "provided" if extract_temperature_c(text) is not None else "missing",
                    "manual_duration_sec": "not_applicable",
                },
            )
            return base

        resolved_duration = duration if duration is not None else _DEFAULT_DURATION_SEC[device_type]
        mode = detect_mode(text, device_type)
        temperature = extract_temperature_c(text)
        if temperature is None:
            temperature = (
                _REFRIGERATOR_DEFAULT_TEMPERATURE_C.get(mode)
                if device_type == "refrigerator"
                else _DEFAULT_TEMPERATURE_C.get(device_type)
            )
        manual_required = bool(_MANUAL_ACTIONS.search(text))
        segments = _manual_segments(text, resolved_duration) if manual_required else []
        manual_duration = sum(segment["duration_sec"] for segment in segments) if manual_required else 0
        # A device step without any operator help still needs a minimal hand-off
        # in practice, but keep it non-manual when no action keyword is present.
        resource_type = "hybrid" if manual_required else "device"

        base.update(
            resource_type=resource_type,
            duration_sec=resolved_duration,
            manual_required=manual_required,
            manual_duration_sec=manual_duration,
            device_requirement={
                "device_type": device_type,
                "mode": mode,
                "temperature_c": temperature,
                "capacity_units": 1,
            },
            field_status={
                "duration_sec": "provided" if duration is not None else "defaulted",
                "device_type": "provided",
                "device_mode": "provided",
                "temperature_c": "provided" if extract_temperature_c(text) is not None else "inferred",
                "manual_duration_sec": "inferred" if manual_required else "not_applicable",
            },
        )
        if manual_required:
            base["manual_segments"] = segments
        return base
