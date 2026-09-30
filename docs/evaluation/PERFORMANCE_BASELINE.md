# 调度性能基线报告

> 这是工程回归基线，不是浙江省大学生人工智能竞赛官方得分或官方评测结果。官方指标、数据集和评测协议以赛事文件为准。

## 运行信息

| 项目 | 值 |
|---|---|
| 生成时间 | `2026-09-30T15:50:50.611524Z` |
| Git revision | `5e5ccef` |
| Python | `3.12.14` |
| 平台 | `macOS-26.6.2-arm64-arm-64bit` |
| Fixture | `fixtures/v1/four-dish-normal.json` |
| 预热次数 | `2` |
| 测量次数 | `20` |
| Solver 状态 | `OPTIMAL` |

## 初始调度耗时（毫秒）

| 指标 | 数值 |
|---|---:|
| min | 0.933 |
| p50 | 0.983 |
| p95 | 1.67 |
| max | 5.748 |

## 复现命令

```bash
/tmp/cookflow-venv/bin/python scripts/generate-performance-report.py \
  --iterations 20 --warmup 2 \
  --json-out docs/evaluation/performance-baseline.json \
  --markdown-out docs/evaluation/PERFORMANCE_BASELINE.md
```

本报告只覆盖固定四道菜 fixture 的确定性初始调度。动态重排、多目标分层求解、官方批量数据和端到端网络耗时必须在对应能力完成后单独测量，不能用本报告替代。
