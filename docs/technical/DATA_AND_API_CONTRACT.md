# 数据模型与 API 契约草案 V1

## 1. 菜谱解析输入

```json
{
  "recipe_id": "dish_001",
  "name": "清蒸鲈鱼",
  "ingredients": ["鲈鱼", "葱", "姜"],
  "steps_text": ["鲈鱼处理后放入蒸箱，普通蒸100度8分钟"]
}
```

## 2. 调度任务输入

```json
{
  "task_id": "dish_001_step_003",
  "dish_id": "dish_001",
  "action": "普通蒸鲈鱼",
  "resource_type": "hybrid",
  "device_requirement": {
    "device_type": "steamer",
    "mode": "normal_steam",
    "temperature_c": 100,
    "capacity_units": 1
  },
  "duration_sec": 480,
  "manual_segments": [
    {"offset_sec": 0, "duration_sec": 30, "action": "放入蒸箱"},
    {"offset_sec": 450, "duration_sec": 30, "action": "取出装盘"}
  ],
  "predecessors": ["dish_001_step_002"],
  "interruptible": false,
  "confidence": 0.96,
  "source_step_index": 2
}
```

说明：具体 `device_unit` 不属于解析输入，由调度器在输出中分配。`manual_segments` 用于表达设备自动运行前后需要短时人工介入，避免用单一布尔字段丢失时序。

## 3. 设备配置

```json
{
  "operator_count": 1,
  "target_ready_at": "2026-09-25T18:15:00+08:00",
  "devices": [
    {
      "device_id": "stove_burner_1",
      "device_type": "stove",
      "capabilities": {"modes": ["low", "medium", "high"]}
    },
    {
      "device_id": "steamer_1",
      "device_type": "steamer",
      "capabilities": {
        "modes": ["normal_steam"],
        "temperature_min_c": 80,
        "temperature_max_c": 120,
        "capacity_units": 2
      }
    }
  ]
}
```

## 4. 排程输出

```json
{
  "schedule_id": "sch_01",
  "solver": {
    "status": "FEASIBLE",
    "objective_value": 1240,
    "best_bound": 1200,
    "gap": 0.0333,
    "duration_ms": 842
  },
  "metrics": {
    "makespan_sec": 2700,
    "finish_spread_sec": 240,
    "max_continuous_manual_sec": 420,
    "device_conflicts": 0,
    "dependency_violations": 0,
    "target_delay_sec": 0
  },
  "tasks": [
    {
      "task_id": "dish_001_step_003",
      "start_offset_sec": 1200,
      "end_offset_sec": 1680,
      "assigned_resources": ["steamer_1"],
      "status": "PENDING",
      "locked": false
    }
  ],
  "validation": {"valid": true, "errors": []},
  "timings_ms": {
    "parse": 0,
    "validation": 12,
    "solve": 842,
    "notification": 8,
    "total": 875
  }
}
```

## 5. 错误模型

```json
{
  "request_id": "req_01",
  "error": {
    "code": "SCHEDULE_INFEASIBLE",
    "message": "当前设备配置无法满足所选菜品",
    "details": ["蒸箱温度要求冲突且目标时间不足"]
  }
}
```

首批错误码：`INVALID_INPUT`、`PARSE_FAILED`、`VALIDATION_FAILED`、`SCHEDULE_INFEASIBLE`、`SOLVER_TIMEOUT`、`EVENT_CONFLICT`、`INTERNAL_ERROR`。

## 6. API 列表

| 方法 | 路径 | 所属模块 |
|---|---|---|
| GET | `/api/v1/recipes` | 菜谱 |
| POST | `/api/v1/recipes/parse` | 解析 |
| POST | `/api/v1/devices/validate` | 设备校验 |
| POST | `/api/v1/schedules` | 初始调度 |
| GET | `/api/v1/schedules/{id}` | 状态查询 |
| POST | `/api/v1/schedules/{id}/events` | 事件上报 |
| POST | `/api/v1/schedules/{id}/replan` | 动态重排 |
| GET | `/api/v1/schedules/{id}/notifications` | 通知 |

API 契约先于前后端并行开发冻结；破坏性变更需要同步更新 Schema、OpenAPI、前端类型和契约测试。
