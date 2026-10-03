# Performance Benchmark

## 三项工程基线

`scripts/benchmark_performance.py` 覆盖赛事 Level 5（性能效率）要求的三类场景：

1. **初始排程**：四道菜 fixture 上的多目标分层 CP-SAT（同出锅时间差 → 总时长 → 连续人工），记录 wall-clock min/p50/p95/max。
2. **动态重排**：`TASK_COMPLETED` 事件经状态机 + 重排求解 + 差异计算的完整链路。
3. **端到端**：100 道官方菜谱的 解析 → 校验 → 调度 全链路，分别记录解析、调度、合计的单菜谱耗时分布与批量总计。

```bash
PYTHONPATH=backend:. python scripts/benchmark_performance.py
# CI 硬门槛
PYTHONPATH=backend:. python scripts/benchmark_performance.py --fail-on-budget
```

结果写入 `docs/evaluation/performance-baseline-full.{json,md}`。

## 与历史单目标基线的对比

历史基线（`docs/evaluation/PERFORMANCE_BASELINE.md`，git `5e5ccef`）对同一四道菜 fixture 的单目标初始调度 p95 为 **1.67ms**。引入多目标分层求解（`feat/46`）后，同一 fixture 的初始排程 p95 升至约 **280ms**，主要来自第三阶段的精确连续人工指标建模（逐对 `link` 布尔 + 对称传递闭包 `same` + 跨度上界，模型规模随人工片段数接近 O(n³)）。

该耗时仍远低于赛事合格线（5000ms），属「精确指标」换「求解速度」的预期取舍。若后续追求更优线或模型规模继续增长，可将连续人工合并关系改为区间并集的后处理近似或加入时间窗裁剪，作为独立优化项评估。

## 约束

- 本机 wall-clock 受环境噪声影响，仅作工程回归信号，不是官方评测分数。
- 官方评测环境与协议以赛事文件为准。
- 报告必须保留运行环境、Git revision、fixture、样本数与生成时间。
