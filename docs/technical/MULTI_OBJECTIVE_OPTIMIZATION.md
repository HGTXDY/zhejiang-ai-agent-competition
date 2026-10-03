# 多目标指标与分层优化设计（V1）

Issue #12 的实现拆成两层：先固定可复用的指标口径，再由 CP-SAT 调度器接入分层求解。指标模块不依赖 OR-Tools，避免 API、重排和报告模块复制计算逻辑。

## 指标口径

### 1. 硬约束违反数

包括设备冲突、依赖冲突和人工资源冲突。硬约束违反数必须为 `0` 才能进入有效解排序。调度器不应通过惩罚分掩盖硬约束违反。

### 2. `finish_spread_sec`

对每道菜取最后一个必需任务的结束时间，计算最大值减最小值。单菜或没有任务时为 `0`。

### 3. `makespan_sec`

所有任务结束时间的最大值。串行基线为所有任务 `duration_sec` 之和，用于报告并行收益，不作为实际排程结果。

### 4. `max_continuous_manual_sec`

按人工资源分别收集人工区间，按照开始时间排序。两个区间之间的空档小于等于 `manual_merge_gap_sec`（默认 30 秒）时合并，取合并区间的最大长度。

## 分层目标

V1 采用字典序最小化：

```text
(hard_constraint_violations,
 finish_spread_sec,
 makespan_sec,
 max_continuous_manual_sec)
```

即：

1. 先保证硬约束违反数为 0；
2. 再尽量缩小多道菜出锅时间差；
3. 再缩短总完成时间；
4. 最后减少最长连续人工操作。

实现方式可以是多阶段求解：每一阶段固定上一阶段最优值；也可以使用经过证明不会改变字典序的权重编码。默认优先使用多阶段求解，避免权重上界变化造成目标层级错误。

## 与 CP-SAT 实现的对应关系

`backend/app/scheduler/cp_sat.py` 已按上述字典序落地分层求解：阶段一固定 `finish_spread` 上界，
阶段二在该约束下最小化 `makespan`，阶段三再最小化 `max_continuous_manual_sec`。每个阶段记录
求解状态、耗时与 bound/gap，指标写入 `schedule-response.metrics`：

- `makespan_sec`、`finish_spread_sec`、`max_continuous_manual_sec`；
- `serial_baseline_sec`（串行基线，所有任务 `duration_sec` 之和）与
  `makespan_compression_ratio`（= makespan / 串行基线，报告并行收益，对应赛题「总烹饪时间压缩率」）；
- `device_conflicts` / `dependency_violations` 由独立结果校验器复检后写入（见 `VALIDATION_ENGINE.md`），
  不再硬编码 0。

指标模块（`app/metrics/multi_objective.py`）不依赖 OR-Tools，调度器与报告共用同一口径。
