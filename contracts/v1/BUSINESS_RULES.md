# V1 业务校验规则

JSON Schema 负责字段类型、必填项、格式和基础范围；以下跨对象规则由 validation 层执行。错误必须包含稳定错误码、对象路径和可读说明。

## 任务与依赖

| 错误码 | 规则 |
|---|---|
| `DUPLICATE_TASK_ID` | 同一请求内 `task_id` 必须唯一 |
| `DANGLING_PREDECESSOR` | 每个 predecessor 必须引用同一请求中存在的任务 |
| `CYCLIC_DEPENDENCY` | 任务依赖图必须为 DAG |
| `CROSS_DISH_REFERENCE_INVALID` | 跨菜依赖必须显式存在，不能由同名步骤推断 |
| `MANUAL_SEGMENT_OUT_OF_RANGE` | `offset_sec + duration_sec` 不得超过任务 `duration_sec` |
| `MANUAL_SEGMENT_OVERLAP` | 同一任务内人工片段不得相互重叠 |
| `DEVICE_REQUIREMENT_FORBIDDEN` | `manual` 或 `wait` 任务不得声明设备要求 |

## 设备能力

| 错误码 | 规则 |
|---|---|
| `DUPLICATE_DEVICE_ID` | `device_id` 必须唯一 |
| `INVALID_TEMPERATURE_RANGE` | 最低温度不得高于最高温度 |
| `DEVICE_TYPE_UNAVAILABLE` | 至少存在一个可用设备满足任务的 `device_type` |
| `DEVICE_MODE_UNSUPPORTED` | 任务模式必须由候选设备支持 |
| `DEVICE_TEMPERATURE_UNSUPPORTED` | 任务温度必须在候选设备范围内 |
| `DEVICE_CAPACITY_INSUFFICIENT` | 任务容量需求不得超过所有候选设备的可用容量 |

V1 设备类型严格限定为比赛给定的七类：`range_hood`（烟机）、`stove`（灶具）、`steamer`（蒸箱）、`oven`（烤箱）、`refrigerator`（冰箱）、`dishwasher`（洗碗机）、`water_purifier`（净水机）。灶眼等可并行单元使用多个具体 `device_id` 表示。

## 排程结果

- 任一具体设备同一时刻的容量占用不得超过 `capacity_units`；
- 单人默认 `operator_count = 1`，人工片段不得重叠；
- 每个任务开始时间不得早于所有前置任务结束时间；
- `end_offset_sec` 必须大于 `start_offset_sec`，且差值等于输入任务时长；
- 设备型/混合型任务必须分配满足类型、模式、温度和容量的具体设备；
- `target_ready_at` 是软目标，只计入 `target_delay_sec`，不得单独令模型不可行；
- `device_conflicts` 和 `dependency_violations` 在成功响应中必须为 0。

## 动态重排

- `COMPLETED` 任务不可改变；
- 已经 `RUNNING` 且 `locked = true` 的任务不可改变开始时间和已分配资源；
- 仅重排受事件影响的未完成任务，并输出逐任务变化；
- 扰动指标至少计算任务开始时间移动量，后续可增加资源切换惩罚；
- 无可行解或求解超时时返回稳定错误码，不返回伪造的可执行排程。
