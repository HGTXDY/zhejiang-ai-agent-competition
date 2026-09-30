#!/usr/bin/env python3
"""Repeatable local benchmark for the real CP-SAT initial scheduler.

This reports engineering measurements only; it is not an official competition
score or a substitute for the competition's required evaluation protocol.
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.scheduler import schedule  # noqa: E402


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    index = (len(ordered) - 1) * fraction
    lower, upper = int(index), min(int(index) + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower)


def run(fixture: Path, iterations: int, warmup: int) -> dict[str, object]:
    request = json.loads(fixture.read_text(encoding="utf-8"))
    for _ in range(warmup):
        schedule(request)
    samples: list[float] = []
    statuses: list[str] = []
    for _ in range(iterations):
        started = time.perf_counter()
        result = schedule(request)
        samples.append((time.perf_counter() - started) * 1000)
        statuses.append(result["solver"]["status"])
    if any(status not in {"OPTIMAL", "FEASIBLE"} for status in statuses):
        raise RuntimeError(f"scheduler produced non-success statuses: {statuses}")
    return {
        "fixture": str(fixture.relative_to(ROOT)),
        "iterations": iterations,
        "warmup": warmup,
        "solver_statuses": sorted(set(statuses)),
        "wall_clock_ms": {
            "min": round(min(samples), 3),
            "p50": round(statistics.median(samples), 3),
            "p95": round(percentile(samples, 0.95), 3),
            "max": round(max(samples), 3),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=ROOT / "fixtures/v1/four-dish-normal.json")
    parser.add_argument("--iterations", type=int, default=20)
    parser.add_argument("--warmup", type=int, default=2)
    parser.add_argument("--max-p95-ms", type=float, default=None)
    args = parser.parse_args()
    if args.iterations < 1 or args.warmup < 0:
        parser.error("iterations must be >= 1 and warmup must be >= 0")
    fixture = args.fixture if args.fixture.is_absolute() else ROOT / args.fixture
    report = run(fixture, args.iterations, args.warmup)
    if args.max_p95_ms is not None and report["wall_clock_ms"]["p95"] > args.max_p95_ms:
        print(json.dumps({**report, "budget_exceeded": True}, ensure_ascii=False, indent=2))
        return 2
    print(json.dumps({**report, "budget_exceeded": False}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
