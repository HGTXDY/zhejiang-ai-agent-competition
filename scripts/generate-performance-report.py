#!/usr/bin/env python3
"""Generate a reproducible engineering performance report for the baseline scheduler."""
from __future__ import annotations

import argparse
import json
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.benchmark_scheduler import run  # noqa: E402


def git_revision() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def render_markdown(report: dict[str, object]) -> str:
    result = report["result"]
    timing = result["wall_clock_ms"]
    return f"""# 调度性能基线报告

> 这是工程回归基线，不是浙江省大学生人工智能竞赛官方得分或官方评测结果。官方指标、数据集和评测协议以赛事文件为准。

## 运行信息

| 项目 | 值 |
|---|---|
| 生成时间 | `{report['generated_at']}` |
| Git revision | `{report['git_revision']}` |
| Python | `{report['python']}` |
| 平台 | `{report['platform']}` |
| Fixture | `{result['fixture']}` |
| 预热次数 | `{result['warmup']}` |
| 测量次数 | `{result['iterations']}` |
| Solver 状态 | `{', '.join(result['solver_statuses'])}` |

## 初始调度耗时（毫秒）

| 指标 | 数值 |
|---|---:|
| min | {timing['min']} |
| p50 | {timing['p50']} |
| p95 | {timing['p95']} |
| max | {timing['max']} |

## 复现命令

```bash
/tmp/cookflow-venv/bin/python scripts/generate-performance-report.py \\
  --iterations 20 --warmup 2 \\
  --json-out docs/evaluation/performance-baseline.json \\
  --markdown-out docs/evaluation/PERFORMANCE_BASELINE.md
```

本报告只覆盖固定四道菜 fixture 的确定性初始调度。动态重排、多目标分层求解、官方批量数据和端到端网络耗时必须在对应能力完成后单独测量，不能用本报告替代。
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=ROOT / "fixtures/v1/four-dish-normal.json")
    parser.add_argument("--iterations", type=int, default=20)
    parser.add_argument("--warmup", type=int, default=2)
    parser.add_argument("--json-out", type=Path, default=ROOT / "docs/evaluation/performance-baseline.json")
    parser.add_argument("--markdown-out", type=Path, default=ROOT / "docs/evaluation/PERFORMANCE_BASELINE.md")
    args = parser.parse_args()
    fixture = args.fixture if args.fixture.is_absolute() else ROOT / args.fixture
    result = run(fixture, args.iterations, args.warmup)
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "git_revision": git_revision(),
        "python": platform.python_version(),
        "platform": platform.platform(),
        "result": result,
    }
    args.json_out.parent.mkdir(parents=True, exist_ok=True)
    args.markdown_out.parent.mkdir(parents=True, exist_ok=True)
    args.json_out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    args.markdown_out.write_text(render_markdown(report), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
