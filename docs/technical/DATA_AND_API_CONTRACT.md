# 数据模型与 API 契约 V1

## 1. 规范来源

机器可读契约以 [`contracts/v1`](../../contracts/v1/README.md) 为唯一事实来源：

- JSON Schema：`contracts/v1/schemas/`；
- 标准 Mock：`contracts/v1/examples/`；
- 跨对象业务规则：`contracts/v1/BUSINESS_RULES.md`；
- 自动校验：`python scripts/validate_contracts.py`。

本文说明对象关系和 API 映射，不重复维护完整字段列表。Schema、实现和本文冲突时，应先停止集成并通过契约 PR 统一，不允许消费方自行猜测。

## 2. 数据流

```text
Recipe（自然语言菜谱）
  → Parser
Task[]（设备类型/能力要求，不含具体设备实例）
  → Validator
Validated ScheduleRequest
  → CP-SAT Scheduler
ScheduleResponse（分配具体 device_id/operator）
  → Event + Replanner
ReplanResponse（新排程、变化列表、扰动指标、通知）
```

## 3. 核心对象

| 对象 | Schema | 说明 |
|---|---|---|
| Recipe | `recipe.schema.json` | 原始菜名、食材和自然语言步骤 |
| Task | `task.schema.json` | Parser 输出和调度器输入的最小任务 |
| DeviceConfiguration | `device.schema.json` | 人工数量、目标时间和设备实例能力 |
| ScheduleRequest | `schedule-request.schema.json` | 初始调度输入及软目标配置 |
| ScheduleResponse | `schedule-response.schema.json` | 求解状态、排程、指标、校验和分阶段耗时 |
| ExecutionEvent | `event-request.schema.json` | 完成、延迟、加菜和设备不可用事件 |
| ReplanResponse | `replan-response.schema.json` | 新排程、逐任务变化和扰动得分 |
| Notification | `notification.schema.json` | 结构化通知，被排程响应引用 |
| API Error | `error.schema.json` | 稳定错误码和结构化错误详情 |

## 4. 不可变语义

- 官方七类设备映射为：`range_hood`、`stove`、`steamer`、`oven`、`refrigerator`、`dishwasher`、`water_purifier`；
- 「净咖一体机」归一化为 `water_purifier`，能力包含 `coffee` 与 `instant_heat` 两类模式，不因枚举名裁剪咖啡模式；
- 「蒸烤箱 / 蒸烤一体机 / 方太智能烹饪设备」按步骤明确模式拆分为 `steamer`（蒸制模式）或 `oven`（烤制模式），无明确模式但有「水箱/加满水」补水信号时按 `steamer` 推断，否则不猜测设备类型；
- 灶具火力档位（1~7 整数档）不在 V1 建模，火力意图由 `stove` 的烹饪方式模式表达；
- 设备能力温度下界放宽至 -50，以覆盖冰箱冷冻温区 -24~-15℃；详见 `data/official/MAPPING_NOTES.md`；
- 多灶眼等具体资源用多个 `device_id` 表示，例如 `stove_burner_1`；
- Parser 输出 `device_requirement` 和人工字段；可选 `device_unit` 仅作为识别提示，最终具体设备由调度器在 `assigned_resources` 中分配并校验；
- 调度器在 `assigned_resources` 中分配具体设备和人工资源；
- 时间长度统一为秒，性能耗时统一为毫秒，绝对时间必须带时区；
- 菜品完成时间等于该菜最后一个必需任务的完成时间；
- 任务必须表达 `manual_required`、`manual_duration_sec`，排程任务必须提供 `notification_points`；
- 重排响应必须提供开始时间偏移总量、资源变更数、顺序变更数和已通知任务变更数；
- 同出锅差值为最晚菜品完成时间减最早菜品完成时间；
- 连续人工片段默认按 30 秒以内间隔合并；
- 目标开饭时间是软目标，不能单独造成不可行；
- LLM 输出必须经过 Schema 和业务规则校验，不能直接成为正式排程。

## 5. API 映射

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| `GET` | `/api/v1/recipes` | — | Recipe 列表 |
| `POST` | `/api/v1/recipes/parse` | Recipe | Task[] + 解析质量信息 |
| `POST` | `/api/v1/devices/validate` | DeviceConfiguration + Task[] | 校验结果 |
| `POST` | `/api/v1/schedules` | ScheduleRequest | ScheduleResponse |
| `GET` | `/api/v1/schedules/{id}` | — | ScheduleResponse |
| `POST` | `/api/v1/schedules/{id}/events` | ExecutionEvent | 事件接收结果 |
| `POST` | `/api/v1/schedules/{id}/replan` | ExecutionEvent 或已接收事件 ID | ReplanResponse |
| `GET` | `/api/v1/schedules/{id}/notifications` | — | Notification[] |

FastAPI/OpenAPI 模型在后端脚手架合并后由 Schema 对应实现，不得更改字段语义。

## 6. 错误模型

稳定错误码首批包括：

- `INVALID_INPUT`；
- `PARSE_FAILED`；
- `VALIDATION_FAILED`；
- `SCHEDULE_INFEASIBLE`；
- `SOLVER_TIMEOUT`；
- `EVENT_CONFLICT`；
- `INTERNAL_ERROR`。

业务校验的细分错误码见 `BUSINESS_RULES.md`。API 错误应包含 `request_id`、稳定 `code`、可读 `message` 和结构化 `details`，不得仅返回求解器原始异常。

## 7. 兼容与并行开发

- `schema_version = 1.0` 为当前基线；
- 下游模块只依赖已合并的 Schema 和 examples，可用 Mock 并行开发；
- 破坏性修改需要主版本升级、迁移说明和另一位研发 Review；
- 每次契约变更必须同步 Schema、examples、本文和契约测试；
- TypeScript 类型应从 JSON Schema 生成，避免手写字段漂移。
