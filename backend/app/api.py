"""FastAPI entrypoint for the V1 schedule service."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from app.scheduler import schedule
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


def _error_response(request_id: str, code: str, message: str, details: list[dict[str, Any]]) -> JSONResponse:
    status_codes = {
        "INVALID_INPUT": 422,
        "VALIDATION_FAILED": 422,
        "SCHEDULE_INFEASIBLE": 409,
        "EVENT_CONFLICT": 409,
        "SOLVER_TIMEOUT": 504,
        "INTERNAL_ERROR": 500,
    }
    return JSONResponse(
        status_code=status_codes.get(code, 500),
        content={
            "schema_version": "1.0",
            "request_id": request_id,
            "error": {"code": code, "message": message, "details": details},
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


def create_app() -> FastAPI:
    app = FastAPI(title="CookFlow Scheduling API", version="1.0")

    @app.exception_handler(RequestValidationError)
    async def request_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        details = [
            {
                "code": "REQUEST_VALIDATION_ERROR",
                "message": error.get("msg", "Invalid request"),
                "path": ".".join(str(part) for part in error.get("loc", ())) or "$",
            }
            for error in exc.errors()
        ]
        request_id = request.headers.get("X-Request-ID", "unknown")
        return _error_response(request_id, "INVALID_INPUT", "Request body is invalid", details)

    @app.exception_handler(Exception)
    async def internal_error(request: Request, exc: Exception) -> JSONResponse:
        # Do not expose exception details to clients; keep the response contract stable.
        request_id = request.headers.get("X-Request-ID", "unknown")
        return _error_response(
            request_id,
            "INTERNAL_ERROR",
            "An unexpected internal error occurred",
            [],
        )
    configured_origins = os.getenv(
        "COOKFLOW_CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[origin.strip() for origin in configured_origins.split(",") if origin.strip()],
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type"],
    )

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "service": "cookflow-scheduling-api", "version": "1.0"}

    @app.post("/v1/schedules")
    def create_schedule(payload: dict[str, Any]) -> Any:
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
        return result

    return app


app = create_app()
