# 完整性能基线报告

> 这是工程回归基线，不是浙江省大学生人工智能竞赛官方得分或官方评测结果。官方指标、数据集和评测协议以赛事文件为准。

## 运行信息

| 项目 | 值 |
|---|---|
| 生成时间 | `2026-10-01T20:03:27.618056Z` |
| Git revision | `cb773f7` |
| Python | `3.12.14` |
| 平台 | `macOS-26.6.2-arm64-arm-64bit` |
| 官方菜谱数 | `100` |

## 1. 初始排程耗时（四道菜 fixture，多目标分层 CP-SAT）

合格线 `5000` ms，结果 `通过`。

| 指标 | 数值（毫秒） |
|---|---:|
| min | 275.746 |
| p50 | 276.947 |
| p95 | 277.974 |
| max | 278.116 |

Solver 状态：`OPTIMAL`；预热 2 次、测量 20 次。

## 2. 动态重排耗时（TASK_COMPLETED 事件）

合格线 `3000` ms，结果 `通过`。

| 指标 | 数值（毫秒） |
|---|---:|
| min | 411.616 |
| p50 | 414.936 |
| p95 | 433.682 |
| max | 435.058 |

预热 2 次、测量 20 次。

## 3. 端到端耗时（解析 → 校验 → 调度，100 道官方菜谱）

单道菜谱耗时分布（毫秒）：

| 阶段 | min | p50 | p95 | max |
|---|---:|---:|---:|---:|
| 解析 | 0.131 | 0.55 | 1.155 | 2.452 |
| 调度 | 0.376 | 5.822 | 47.245 | 69.142 |
| 合计 | 0.517 | 6.378 | 48.404 | 70.447 |

100 道菜批量总计（5 轮累计）：解析 314.533 ms，调度 5778.645 ms，端到端 6093.178 ms。Solver 状态：`OPTIMAL`。

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
