"""FastAPI entrypoint for the CookFlow scheduling service.

The API exposes two complementary surfaces:

* the stateless, envelope-based V1 endpoints (``/v1/schedules`` and
  ``/v1/replans``) that keep the scheduler and replan service free of storage;
* the PRD Table 19 evaluation-facing REST endpoints (``/schedules`` and
  friends), backed by a process-local in-memory store so ``GET /schedules/{id}``,
  event reporting and notification queries have a working call path.
"""
from __future__ import annotations

import json
import os
from copy import deepcopy
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from app.agent import interpret_command, interpret_plan
from app.catalog import get_recipe_payload, list_recipe_summaries
from app.device_check import validate_device_config
from app.parser.adapter import InputRecipeError, ParsedTaskError, RecipeParser
from app.parser.deterministic import DeterministicParserAdapter
from app.parser.llm import LLMParserAdapter
from app.preparation_phases import classify_preparation_phases
from app.model_config import ModelConfigService
from app.replan import ReplanError, apply_event_to_request, replan
from app.scheduler import schedule
from app.store import ScheduleStore, store
from app.validation import annotate_schedule_result
from scripts.validate_contracts import validate_schedule_request_business_rules

ROOT = Path(__file__).resolve().parents[2]
SCHEMA_DIR = ROOT / "contracts" / "v1" / "schemas"


def _schemas() -> tuple[dict[str, dict[str, Any]], Registry]:
    schemas = {
        path.name: json.loads(path.read_text(encoding="utf-8"))
        for path in SCHEMA_DIR.glob("*.json")
    }
    registry = Registry().with_resources(
        (name, Resource.from_contents(schema)) for name, schema in schemas.items()
    )
    return schemas, registry


SCHEMAS, SCHEMA_REGISTRY = _schemas()
REQUEST_VALIDATOR = Draft202012Validator(
    SCHEMAS["schedule-request.schema.json"],
    registry=SCHEMA_REGISTRY,
    format_checker=FormatChecker(),
)
RECIPE_VALIDATOR = Draft202012Validator(
    SCHEMAS["recipe.schema.json"],
    registry=SCHEMA_REGISTRY,
    format_checker=FormatChecker(),
)


def _recipe_parser(
    *,
    strict: bool = False,
    provider: str = "deterministic",
    model_config: ModelConfigService | None = None,
) -> RecipeParser:
    if provider == "llm":
        client = model_config.active_client() if model_config is not None else None
        return RecipeParser(LLMParserAdapter(client=client, strict=strict), provider="llm")
    return RecipeParser(DeterministicParserAdapter(strict=strict))


def _error_response(request_id: str, code: str, message: str, details: list[dict[str, Any]]) -> JSONResponse:
    return JSONResponse(
        status_code=422 if code in {"INVALID_INPUT", "VALIDATION_FAILED", "PARSE_FAILED"} else 409,
        content={
            "schema_version": "1.0",
            "request_id": request_id,
            "error": {"code": code, "message": message, "details": details},
        },
    )


def _not_found(schedule_id: str) -> JSONResponse:
    return JSONResponse(
        status_code=404,
        content={
            "schema_version": "1.0",
            "request_id": schedule_id,
            "error": {"code": "SCHEDULE_NOT_FOUND", "message": f"Unknown schedule {schedule_id}", "details": []},
        },
    )


def _replan_error(error: ReplanError, request_id: str) -> JSONResponse:
    return JSONResponse(
        status_code=error.status_code,
        content={
            "schema_version": "1.0",
            "request_id": request_id,
            "error": {"code": error.code, "message": error.message, "details": error.details},
        },
    )


def _schema_details(payload: dict[str, Any]) -> list[dict[str, Any]]:
    errors = sorted(REQUEST_VALIDATOR.iter_errors(payload), key=lambda error: list(error.absolute_path))
    return [
        {
            "code": "SCHEMA_VALIDATION_ERROR",
            "message": error.message,
            "path": ".".join(str(part) for part in error.absolute_path) or "$",
        }
        for error in errors
    ]


def _create_schedule(payload: dict[str, Any], registry: ScheduleStore) -> Any:
    request_id = str(payload.get("request_id") or "unknown")
    schema_details = _schema_details(payload)
    if schema_details:
        return _error_response(request_id, "INVALID_INPUT", "Schedule request does not satisfy V1 schema", schema_details)

    business_errors = validate_schedule_request_business_rules(payload)
    if business_errors:
        return _error_response(
            request_id,
            "VALIDATION_FAILED",
            "Schedule request violates V1 business rules",
            [{"code": code, "message": code, "path": None} for code in business_errors],
        )

    result = schedule(payload)
    solver_status = result["solver"]["status"]
    if solver_status == "UNKNOWN":
        return JSONResponse(status_code=504, content={
            "schema_version": "1.0",
            "request_id": request_id,
            "error": {"code": "SOLVER_TIMEOUT", "message": "Scheduler timed out", "details": []},
        })
    if solver_status == "INFEASIBLE":
        return JSONResponse(status_code=409, content={
            "schema_version": "1.0",
            "request_id": request_id,
            "error": {"code": "SCHEDULE_INFEASIBLE", "message": "No feasible schedule found", "details": result["validation"]["errors"]},
        })
    annotate_schedule_result(payload, result)
    registry.put(payload, result)
    return result


def _replan_event(store: ScheduleStore, schedule_id: str, event: dict[str, Any]) -> Any:
    session = store.get(schedule_id)
    if session is None:
        return _not_found(schedule_id)
    event = dict(event)
    event.setdefault("schedule_id", schedule_id)
    try:
        result = replan(
            {
                "event": event,
                "schedule_request": session["request"],
                "current_schedule": session["schedule"],
            }
        )
    except ReplanError as error:
        return _replan_error(error, event.get("event_id") or schedule_id)
    request = session["request"]  # already a deep copy from store.get()
    apply_event_to_request(request, event)
    new_id = store.replace(schedule_id, request, result["schedule"])
    affected = [
        change["task_id"] for change in result["changes"] if change["change_type"] not in {"UNCHANGED", "LOCKED"}
    ]
    return {
        "schema_version": "1.0",
        "event_id": event["event_id"],
        "accepted": True,
        "schedule_id": new_id,
        "affected_task_ids": affected,
    }


def create_app(app_store: ScheduleStore | None = None) -> FastAPI:
    registry = app_store or store
    model_config = ModelConfigService()
    app = FastAPI(
        title="CookFlow Scheduling API",
        version="1.0",
        description="灶序（CookFlow）智能烹饪调度 Agent — 菜谱解析、设备校验、初始排程与事件驱动动态重排。",
    )
    configured_origins = os.getenv(
        "COOKFLOW_CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5180,http://127.0.0.1:5180",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[origin.strip() for origin in configured_origins.split(",") if origin.strip()],
        # Vite may move to the next free port when another dev server is
        # already running (for example 5174 or 5181). Keep arbitrary remote
        # origins disallowed, but allow local browser development on any
        # localhost/loopback port so the UI does not fail with a misleading
        # "load failed" message. Production deployments can still provide an
        # explicit allow-list through COOKFLOW_CORS_ORIGINS.
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type"],
    )

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "service": "cookflow-scheduling-api", "version": "1.0"}

    @app.get("/settings/model")
    def get_model_settings() -> dict[str, Any]:
        return model_config.public_settings()

    @app.put("/settings/model")
    def update_model_settings(payload: dict[str, Any]) -> dict[str, Any]:
        try:
            return model_config.update(payload)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post("/settings/model/test")
    def test_model_settings(payload: dict[str, Any]) -> dict[str, Any]:
        try:
            return model_config.probe(payload)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        except ParsedTaskError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @app.delete("/settings/model")
    def reset_model_settings() -> dict[str, Any]:
        return model_config.reset()

    @app.post("/agent/plan")
    def agent_plan(payload: dict[str, Any]) -> dict[str, Any]:
        try:
            return interpret_plan(payload, client=model_config.active_client())
        except ParsedTaskError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.post("/agent/command")
    def agent_command(payload: dict[str, Any]) -> dict[str, Any]:
        return interpret_command(payload)

    @app.get("/recipes")
    def list_recipes(limit: int | None = None, q: str | None = None) -> dict[str, Any]:
        return list_recipe_summaries(limit=limit, q=q)

    @app.get("/recipes/{recipe_id}")
    def get_recipe(recipe_id: str) -> Any:
        payload = get_recipe_payload(recipe_id)
        if payload is None:
            return JSONResponse(
                status_code=404,
                content={
                    "schema_version": "1.0",
                    "request_id": recipe_id,
                    "error": {"code": "RECIPE_NOT_FOUND", "message": f"Unknown recipe {recipe_id}", "details": []},
                },
            )
        return payload

    @app.post("/recipes/parse")
    def parse_recipe(payload: dict[str, Any], strict: bool = False, provider: str = "deterministic") -> Any:
        request_id = str(payload.get("recipe_id") or "unknown")
        recipe_errors = sorted(
            RECIPE_VALIDATOR.iter_errors(payload), key=lambda error: list(error.absolute_path)
        )
        if recipe_errors:
            return _error_response(
                request_id,
                "INVALID_INPUT",
                "Recipe does not satisfy V1 schema",
                [
                    {
                        "code": "SCHEMA_VALIDATION_ERROR",
                        "message": error.message,
                        "path": ".".join(str(part) for part in error.absolute_path) or "$",
                    }
                    for error in recipe_errors
                ],
            )
        try:
            result = _recipe_parser(strict=strict, provider=provider, model_config=model_config).parse(payload)
        except ValueError as error:
            return _error_response(request_id, "PARSE_FAILED", str(error), [])
        except InputRecipeError as error:
            return _error_response(request_id, "INVALID_INPUT", str(error), [])
        except ParsedTaskError as error:
            return _error_response(request_id, "PARSE_FAILED", str(error), [])
        return {
            "schema_version": "1.0",
            "recipe_id": result.recipe_id,
            "provider": result.provider,
            "tasks": list(result.tasks),
            "preparation_phases": classify_preparation_phases(list(result.tasks)),
        }

    @app.post("/devices/validate")
    def validate_devices(payload: dict[str, Any]) -> dict[str, Any]:
        return validate_device_config(payload)

    @app.post("/v1/schedules")
    @app.post("/schedules")
    def create_schedule(payload: dict[str, Any]) -> Any:
        return _create_schedule(payload, registry)

    @app.get("/schedules/{schedule_id}")
    def get_schedule(schedule_id: str) -> Any:
        session = registry.get(schedule_id)
        if session is None:
            return _not_found(schedule_id)
        return session["schedule"]

    @app.get("/schedules/{schedule_id}/notifications")
    def get_notifications(schedule_id: str) -> Any:
        session = registry.get(schedule_id)
        if session is None:
            return _not_found(schedule_id)
        return {
            "schema_version": "1.0",
            "schedule_id": schedule_id,
            "notifications": session["schedule"].get("notifications", []),
        }

    @app.post("/schedules/{schedule_id}/events")
    def report_event(schedule_id: str, event: dict[str, Any]) -> Any:
        return _replan_event(registry, schedule_id, event)

    @app.post("/schedules/{schedule_id}/replan")
    def replan_stored(schedule_id: str, envelope: dict[str, Any]) -> Any:
        session = registry.get(schedule_id)
        if session is None:
            return _not_found(schedule_id)
        event = envelope.get("event")
        if not isinstance(event, dict) or not event.get("event_id"):
            return _error_response(schedule_id, "INVALID_INPUT", "Replan request is missing a valid event", [])
        event = dict(event)
        event.setdefault("schedule_id", schedule_id)
        request = envelope.get("schedule_request") or session["request"]
        try:
            result = replan(
                {
                    "event": event,
                    "schedule_request": request,
                    "current_schedule": session["schedule"],
                }
            )
        except ReplanError as error:
            return _replan_error(error, event.get("event_id") or schedule_id)
        new_request = deepcopy(request)
        apply_event_to_request(new_request, event)
        registry.replace(schedule_id, new_request, result["schedule"])
        return result

    @app.post("/v1/replans")
    def create_replan(envelope: dict[str, Any]) -> Any:
        event_id = str(envelope.get("event", {}).get("event_id") or "unknown")
        try:
            return replan(envelope)
        except ReplanError as error:
            return _replan_error(error, event_id)

    return app


app = create_app()
