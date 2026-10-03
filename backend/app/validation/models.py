"""Pydantic v2 models mirroring the V1 scheduling input contract."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

DeviceType = Literal["range_hood", "stove", "steamer", "oven", "refrigerator", "dishwasher", "water_purifier"]
ResourceType = Literal["manual", "device", "hybrid", "wait"]
FieldStatus = Literal["provided", "inferred", "defaulted", "missing", "not_applicable"]


class V1Model(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class DeviceCapabilities(V1Model):
    modes: list[str] = Field(default_factory=list, min_length=0)
    # Lower bound -50 covers the refrigerator's 冷冻 -24~-15℃ official range.
    temperature_min_c: int | None = Field(default=None, ge=-50, le=500)
    temperature_max_c: int | None = Field(default=None, ge=-50, le=500)

    @model_validator(mode="after")
    def valid_temperature_range(self) -> "DeviceCapabilities":
        if self.temperature_min_c is not None and self.temperature_max_c is not None and self.temperature_min_c > self.temperature_max_c:
            raise ValueError("temperature_min_c must not exceed temperature_max_c")
        return self


class Device(V1Model):
    device_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{0,63}$")
    device_type: DeviceType
    capacity_units: int = Field(ge=1)
    capabilities: DeviceCapabilities
    available: bool = True


class DeviceConfig(V1Model):
    schema_version: Literal["1.0"]
    operator_count: int = Field(ge=1, le=20)
    target_ready_at: datetime | None = None
    devices: list[Device] = Field(min_length=1)


class ManualSegment(V1Model):
    offset_sec: int = Field(ge=0)
    duration_sec: int = Field(ge=1)
    action: str = Field(min_length=1, max_length=200)


class DeviceRequirement(V1Model):
    device_type: DeviceType
    mode: str | None = Field(default=None, min_length=1)
    temperature_c: int | None = Field(default=None, ge=-50, le=500)
    capacity_units: int = Field(ge=1)


class Task(V1Model):
    schema_version: Literal["1.0"]
    task_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{0,127}$")
    dish_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{0,63}$")
    action: str = Field(min_length=1, max_length=200)
    resource_type: ResourceType
    device_requirement: DeviceRequirement | None = None
    duration_sec: int = Field(ge=1, le=86400)
    manual_segments: list[ManualSegment] = Field(default_factory=list)
    predecessors: list[str] = Field(default_factory=list)
    interruptible: bool
    confidence: float | None = Field(default=None, ge=0, le=1)
    source_step_index: int | None = Field(default=None, ge=0)
    device_unit: str | None = Field(default=None, min_length=1)
    manual_required: bool
    manual_duration_sec: int = Field(ge=0, le=86400)
    field_status: dict[str, FieldStatus] | None = None

    @model_validator(mode="after")
    def resource_requirement_matches(self) -> "Task":
        if self.resource_type in {"device", "hybrid"} and self.device_requirement is None:
            raise ValueError("device_requirement is required for device and hybrid tasks")
        if self.resource_type in {"manual", "wait"} and self.device_requirement is not None:
            raise ValueError("device_requirement is not allowed for manual and wait tasks")
        return self


class ObjectiveConfig(V1Model):
    finish_spread_priority: int = Field(default=100, ge=0, le=100)
    makespan_priority: int = Field(default=80, ge=0, le=100)
    manual_continuity_priority: int = Field(default=60, ge=0, le=100)
    target_delay_priority: int = Field(default=40, ge=0, le=100)
    manual_merge_gap_sec: int = Field(default=30, ge=0, le=600)
    max_solve_time_sec: float = Field(default=5, gt=0, le=60)


class ScheduleRequest(V1Model):
    schema_version: Literal["1.0"]
    request_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
    tasks: list[Task] = Field(min_length=1)
    device_config: DeviceConfig
    objective: ObjectiveConfig | None = None
