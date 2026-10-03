# 评测与性能报告

本目录保存可重复生成的工程基线，不等同于赛事官方评分。

## 当前报告

- [完整性能基线](performance-baseline-full.md)：初始排程、动态重排、端到端（100 道官方菜谱）三项。
- [机器可读结果](performance-baseline-full.json)
- [历史单目标基线](PERFORMANCE_BASELINE.md)：固定四道菜 fixture 的初始调度（多目标分层求解引入前）。

## 生成

```bash
PYTHONPATH=backend:. python scripts/benchmark_performance.py
```

默认参数：初始排程预热 2 次、测量 20 次；动态重排预热 2 次、测量 20 次；端到端预热 1 次、测量 5 次（每次覆盖 100 道菜谱）。报告记录各阶段的 min、p50、p95、max（毫秒），并以赛事 Level 5 合格线（初始 <5000ms、重排 <3000ms）作为门槛；`--fail-on-budget` 可在 CI 中把合格线变成硬门槛。

报告必须同时保留运行环境、Git revision、fixture、样本数和生成时间，避免把本机结果误写成竞赛成绩。动态重排与端到端耗时会随多目标分层求解和解析闭环的变化而波动，任何求解器或解析器改动后都应重新生成。
