# API 端点对齐（PRD Table 19）

对应 Issue #49（T-019）。目标：让「API 接口用于自动测评」有明确的调用入口，端点口径与
PRD Table 19 一致。本仓库选择了**补齐端点**方案（而非修订 PRD 收敛到无状态三端点），
因为自动测评是官方交付物，评测脚本需要能按 Table 19 找到端点。

## 1. 决策与口径

- **规范端点（评测入口）**：采用 PRD Table 19 的无版本路径，即 `/recipes`、`/schedules` 等。
- **版本化别名**：保留既有 `/v1/schedules` 与 `/v1/replans`，供前端与既有测试兼容。
  其中 `/v1/replans` 仍是无状态信封式（请求体自带 `current_schedule`），不依赖存储。
- **存储策略**：调度器与重排服务本身保持无状态；`/schedules` 系列的有状态端点由
  进程内内存存储（`app/store.py`）支撑，进程重启即清空。不引入外部持久化，符合
  Issue 非目标「不强制引入状态存储」。

## 2. 端点清单

| Table 19 | 已实现路径 | 方法 | 说明 |
|---|---|---|---|
| GET /recipes | `/recipes` | GET | 菜谱摘要数组，支持 `limit`、`q`（名称过滤） |
| POST /recipes/parse | `/recipes/parse` | POST | 菜谱文本 → 结构化步骤；`strict` 控制未解析字段是否阻断 |
| POST /devices/validate | `/devices/validate` | POST | 设备配置 → 能力与错误报告 |
| POST /schedules | `/schedules` | POST | 生成初始排程（等价 `/v1/schedules`） |
| GET /schedules/{id} | `/schedules/{schedule_id}` | GET | 查询最新排程 |
| POST /schedules/{id}/events | `/schedules/{schedule_id}/events` | POST | 上报事件，返回确认与新排程号 |
| POST /schedules/{id}/replan | `/schedules/{schedule_id}/replan` | POST | 动态重排，返回完整差异摘要 |
| GET /schedules/{id}/notifications | `/schedules/{schedule_id}/notifications` | GET | 查询最新排程的通知数组 |

扩展端点（Table 19 之外，服务于「列清单 → 取菜谱 → 解析」闭环）：

| 路径 | 方法 | 说明 |
|---|---|---|
| `/recipes/{recipe_id}` | GET | 返回可直接提交 `/recipes/parse` 的完整菜谱 payload |

操作端点（非 Table 19）：`GET /health`。

## 3. 示例请求与错误码

### 3.1 列菜谱 / 取菜谱 / 解析

```bash
curl 'http://127.0.0.1:8000/recipes?limit=3&q=鸡翅'
curl 'http://127.0.0.1:8000/recipes/5d54bae2a9114174727c8b20'
curl -X POST 'http://127.0.0.1:8000/recipes/parse' \
  -H 'Content-Type: application/json' \
  -d "$(curl -s 'http://127.0.0.1:8000/recipes/5d54bae2a9114174727c8b20')"
```

| 状态 | 错误码 | 场景 |
|---|---|---|
| 404 | `RECIPE_NOT_FOUND` | 菜谱 id 不存在 |
| 422 | `INVALID_INPUT` | 菜谱不满足 `recipe.schema.json` |
| 422 | `PARSE_FAILED` | 解析器无法产出合法任务 |

### 3.2 设备校验

```bash
curl -X POST 'http://127.0.0.1:8000/devices/validate' \
  -H 'Content-Type: application/json' -d @fixtures/v1/four-dish-normal.json  # 取其中的 device_config
```

| 状态 | 错误码 | 场景 |
|---|---|---|
| 200 | （`valid:false` + `errors`） | 业务错误：`DUPLICATE_DEVICE_ID`、`INVALID_TEMPERATURE_RANGE`、`SCHEMA_VALIDATION_ERROR` |

### 3.3 排程生命周期

```bash
SCHEDULE_ID=$(curl -s -X POST 'http://127.0.0.1:8000/schedules' \
  -H 'Content-Type: application/json' -d @fixtures/v1/four-dish-normal.json | jq -r .schedule_id)

curl "http://127.0.0.1:8000/schedules/$SCHEDULE_ID"
curl "http://127.0.0.1:8000/schedules/$SCHEDULE_ID/notifications"

# 上报一个加菜事件
curl -X POST "http://127.0.0.1:8000/schedules/$SCHEDULE_ID/events" \
  -H 'Content-Type: application/json' -d '{
    "schema_version": "1.0",
    "event_id": "evt-1",
    "event_type": "DISH_ADDED",
    "occurred_at": "2026-09-27T12:00:00Z",
    "payload": {"tasks": [ /* 新增任务，符合 task.schema.json */ ]}
  }'
```

| 状态 | 错误码 | 场景 |
|---|---|---|
| 404 | `SCHEDULE_NOT_FOUND` | 排程号不存在 |
| 422 | `SCHEDULE_MISMATCH` | 事件 `schedule_id` 与路径不符 |
| 422 | `INVALID_STATE_TRANSITION` | 事件违反状态机（如未开始就完成） |
| 422 | `UNKNOWN_DEVICE` | 设备不可用事件指向未知设备 |
| 409 | `SCHEDULE_INFEASIBLE` | 重排无可行解 |
| 504 | `SOLVER_TIMEOUT` | 求解器超时 |

## 4. 实现边界与联调说明

- `/v1/schedules` 与 `/v1/replans` 是无状态、契约优先的版本化接口；`/schedules` 系列是带进程内存储的评测接口。
- `/v1/replans` 会在事件应用前后分别执行输入 Schema 与业务规则校验；事件导致悬空依赖、循环依赖或人工时长不一致时返回 `422 VALIDATION_FAILED`，不会进入求解器。
- 重排响应中的 `schedule.notifications` 同时保留最新排程的关键节点通知和本次重排差异通知，前端应直接展示后端返回结果。
- 进程内存储仅用于演示和评测，服务重启后排程状态不保留；正式部署如需持久化，应在不改变 V1 契约的前提下接入外部存储。
