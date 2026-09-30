"""Provider-independent recipe parsing boundary.

The parser accepts a validated V1 recipe payload and emits validated V1 tasks.
It deliberately does not assign concrete device instances; that remains the
scheduler's responsibility.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
import json

from jsonschema import Draft202012Validator


ROOT = Path(__file__).resolve().parents[3]
SCHEMA_DIR = ROOT / "contracts" / "v1" / "schemas"


class ParserError(ValueError):
    """Base error for parser boundary failures."""


class InputRecipeError(ParserError):
    """Raised when the input recipe does not satisfy the V1 recipe contract."""


class ParsedTaskError(ParserError):
    """Raised when an adapter emits an invalid or unresolved task."""


class ParserAdapter(Protocol):
    """Replaceable provider adapter contract."""

    def parse(self, recipe: dict[str, Any]) -> list[dict[str, Any]]:
        """Convert one V1 recipe into V1 scheduling tasks."""


@dataclass(frozen=True)
class ParserResult:
    """Successful parser response with provenance preserved."""

    recipe_id: str
    tasks: tuple[dict[str, Any], ...]
    provider: str


class FakeParserAdapter:
    """Deterministic adapter for tests and local development.

    The mapping is intentionally explicit: a missing recipe id fails instead of
    inventing scheduling data or silently falling back to a default task.
    """

    provider = "fake"

    def __init__(self, task_mapping: dict[str, list[dict[str, Any]]]) -> None:
        self._task_mapping = task_mapping

    def parse(self, recipe: dict[str, Any]) -> list[dict[str, Any]]:
        recipe_id = recipe["recipe_id"]
        if recipe_id not in self._task_mapping:
            raise ParsedTaskError(f"No fake parser fixture for recipe {recipe_id}")
        # Return copies so an adapter consumer cannot mutate fixture state.
        return [dict(task) for task in self._task_mapping[recipe_id]]


class RecipeParser:
    """Validate recipe input and adapter output at the parser boundary."""

    def __init__(self, adapter: ParserAdapter, *, provider: str | None = None) -> None:
        self.adapter = adapter
        self.provider = provider or getattr(adapter, "provider", adapter.__class__.__name__)
        self._recipe_validator = _load_validator("recipe.schema.json")
        self._task_validator = _load_validator("task.schema.json")

    def parse(self, recipe: dict[str, Any]) -> ParserResult:
        recipe_errors = sorted(self._recipe_validator.iter_errors(recipe), key=lambda error: list(error.path))
        if recipe_errors:
            detail = "; ".join(_format_schema_error(error) for error in recipe_errors)
            raise InputRecipeError(f"Invalid V1 recipe: {detail}")

        tasks = self.adapter.parse(recipe)
        if not tasks:
            raise ParsedTaskError(f"Parser returned no tasks for recipe {recipe['recipe_id']}")

        for task in tasks:
            self._validate_task(task)

        return ParserResult(recipe_id=recipe["recipe_id"], tasks=tuple(tasks), provider=self.provider)

    def _validate_task(self, task: dict[str, Any]) -> None:
        errors = sorted(self._task_validator.iter_errors(task), key=lambda error: list(error.path))
        if errors:
            detail = "; ".join(_format_schema_error(error) for error in errors)
            raise ParsedTaskError(f"Invalid V1 task: {detail}")

        field_status = task.get("field_status", {})
        resource_type = task["resource_type"]
        if resource_type in {"device", "hybrid"} and field_status.get("device_type") == "missing":
            raise ParsedTaskError(f"Task {task['task_id']} has unresolved device_type")
        if field_status.get("duration_sec") == "missing":
            raise ParsedTaskError(f"Task {task['task_id']} has unresolved duration_sec")
        if field_status.get("manual_duration_sec") == "missing":
            raise ParsedTaskError(f"Task {task['task_id']} has unresolved manual_duration_sec")


def _load_validator(filename: str) -> Draft202012Validator:
    schema = json.loads((SCHEMA_DIR / filename).read_text(encoding="utf-8"))
    return Draft202012Validator(schema)


def _format_schema_error(error: Any) -> str:
    path = ".".join(str(part) for part in error.path) or "$"
    return f"{path}: {error.message}"
