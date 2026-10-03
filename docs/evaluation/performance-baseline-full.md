# 完整性能基线报告

> 这是工程回归基线，不是浙江省大学生人工智能竞赛官方得分或官方评测结果。官方指标、数据集和评测协议以赛事文件为准。

## 运行信息

| 项目 | 值 |
|---|---|
| 生成时间 | `2026-10-03T05:27:14.550152Z` |
| Git revision | `8913f34` |
| Python | `3.12.14` |
| 平台 | `macOS-26.6.2-arm64-arm-64bit` |
| 官方菜谱数 | `100` |

## 1. 初始排程耗时（四道菜 fixture，多目标分层 CP-SAT）

合格线 `5000` ms，结果 `通过`。

| 指标 | 数值（毫秒） |
|---|---:|
| min | 267.612 |
| p50 | 267.889 |
| p95 | 268.012 |
| max | 268.026 |

Solver 状态：`OPTIMAL`；预热 1 次、测量 3 次。

## 2. 动态重排耗时（TASK_COMPLETED 事件）

合格线 `3000` ms，结果 `通过`。

| 指标 | 数值（毫秒） |
|---|---:|
| min | 400.67 |
| p50 | 401.234 |
| p95 | 401.318 |
| max | 401.327 |

预热 1 次、测量 3 次。

## 3. 端到端耗时（解析 → Schema/业务校验 → 求解 → 通知，100 道官方菜谱）

单道菜谱耗时分布（毫秒）：

| 阶段 | min | p50 | p95 | max |
|---|---:|---:|---:|---:|
| 解析 | 0.127 | 0.527 | 1.015 | 1.334 |
| Schema + 业务校验 | 0.382 | 0.777 | 1.283 | 1.647 |
| 求解 | 0.373 | 5.562 | 42.927 | 63.318 |
| 通知 | 0.006 | 0.017 | 0.032 | 0.285 |
| 合计 | 0.89 | 6.851 | 45.647 | 66.0 |

100 道菜批量总计（1 轮累计）：解析 58.899 ms，校验 85.014 ms，求解 1104.992 ms，通知 2.117 ms，端到端 1251.022 ms。Solver 状态：`OPTIMAL`。

## 复现命令

```bash
PYTHONPATH=backend:. python scripts/benchmark_performance.py \
  --initial-iterations 20 --initial-warmup 2 \
  --replan-iterations 20 --replan-warmup 2 \
  --e2e-iterations 5 --e2e-warmup 1 \
  --json-out docs/evaluation/performance-baseline-full.json \
  --markdown-out docs/evaluation/performance-baseline-full.md
```

CI 中可用 `--fail-on-budget` 以合格线作为硬门槛。
