# V1 校验引擎

## 定位

`backend/app/validation` 是灶序调度 Agent 的独立校验层，负责在进入调度器前后检查 V1 请求和排程结果的结构、领域约束与资源可行性。该模块不依赖 FastAPI、HTTP 请求上下文或 OR-Tools，可以被 API、CLI 和测试直接调用。

## 接口

```python
from app.validation import (
    build_device_candidates,
    validate_schedule_request,
    validate_schedule_result,
)

request_result = validate_schedule_request(request_dict)
candidates = build_device_candidates(request_dict)
result = validate_schedule_result(request_dict, response_dict)
```

`ValidationResult` 始终包含 `valid` 和稳定的 `errors` 列表；每条 `ValidationIssue` 包含：

- `code`：机器可判断的错误码；
- `message`：供日志和调试使用的可读信息；
- `path`：尽可能定位到请求或响应字段的点号路径。

## 请求校验流程

1. 使用 `contracts/v1/schemas/schedule-request.schema.json` 做 JSON Schema 校验；
2. 使用 Pydantic v2 模型执行类型、枚举和数值范围校验；
3. 检查 task/device ID 唯一性、前置任务存在性和 DAG 环；
4. 检查人工时长、人工片段范围和重叠；
5. 检查 `resource_type` 与 `device_requirement` 一致性；
6. 检查设备类型、模式、温度、容量与 `available` 状态，并报告没有可用候选设备的任务。

## 候选设备

`build_device_candidates` 返回 `{task_id: [device_id, ...]}`。结果按请求中设备的顺序返回，只包含满足以下条件的设备：

- `available=true`；
- `device_type` 匹配；
- 模式存在于设备能力中（任务声明模式时）；
- 温度落在设备上下限内（任务声明温度时）；
- 设备容量不小于任务需求。

## 排程结果校验

排程结果先通过 `schedule-response.schema.json`，随后独立检查：

- 任务集合和请求一致；
- 实际时长与请求一致；
- 前置任务先完成；
- 分配的设备满足任务能力要求；
- 同一设备的并发容量不超限；
- 人工片段并发数不超过 `operator_count`。

资源冲突使用事件扫描，而不是仅做两两比较，因此可以发现三个及以上任务同时重叠的情况；结束事件先于同一时刻的开始事件处理，所以首尾相接的任务不会被误判为冲突。

## 错误码

当前稳定错误码包括：

- `SCHEMA_VALIDATION_ERROR`
- `PYDANTIC_VALIDATION_ERROR`
- `DUPLICATE_TASK_ID` / `DUPLICATE_DEVICE_ID`
- `DANGLING_PREDECESSOR` / `CYCLIC_DEPENDENCY`
- `MANUAL_DURATION_INVALID`
- `MANUAL_SEGMENT_OUT_OF_RANGE` / `MANUAL_SEGMENT_OVERLAP`
- `NO_COMPATIBLE_DEVICE`
- `TASK_SET_MISMATCH` / `TASK_DURATION_MISMATCH`
- `DEPENDENCY_VIOLATION`
- `RESOURCE_CAPABILITY_MISMATCH`
- `DEVICE_CAPACITY_CONFLICT`
- `OPERATOR_CAPACITY_CONFLICT`

## 测试

在仓库根目录执行：

```bash
PYTHONPATH=backend:. pytest -q backend/tests/test_validation_engine.py
PYTHONPATH=backend:. pytest -q
```

契约文件保持在 `contracts/v1`，校验引擎只读取它们，不修改比赛原始资料或契约内容。
