import json
from pathlib import Path

from app.scheduler import schedule


def test_scheduler_horizon_covers_locked_task_beyond_aggregate_duration():
    request = json.loads((Path(__file__).resolve().parents[2] / "fixtures" / "v1" / "four-dish-normal.json").read_text(encoding="utf-8"))
    task = request["tasks"][0]
    delayed_start = sum(item["duration_sec"] for item in request["tasks"]) + 600
    result = schedule(request, locked_tasks={task["task_id"]: {"start_offset_sec": delayed_start}})
    assert result["solver"]["status"] in {"OPTIMAL", "FEASIBLE"}
    scheduled = next(item for item in result["tasks"] if item["task_id"] == task["task_id"])
    assert scheduled["start_offset_sec"] == delayed_start
