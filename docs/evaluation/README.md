# 评测与性能报告

本目录保存可重复生成的工程基线，不等同于赛事官方评分。

## 当前报告

- [调度性能基线](PERFORMANCE_BASELINE.md)
- [机器可读结果](performance-baseline.json)

## 生成

```bash
python scripts/generate-performance-report.py
```

报告默认测试 `fixtures/v1/four-dish-normal.json`，预热 2 次、测量 20 次，记录调度器 wall-clock 的 min、p50、p95 和 max。为了避免把本机结果误写成竞赛成绩，报告必须同时保留运行环境、Git revision、fixture、样本数和生成时间。
