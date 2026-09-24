# CookFlow Contract Package V1

`contracts/v1` 是数据、后端、算法和外部交互模块之间的唯一公共契约。实现代码不得复制一份字段定义后自行演化。

## 目录

- `schemas/`：JSON Schema Draft 2020-12；
- `examples/`：可直接用于并行开发、Mock 和契约测试的有效载荷；
- `scripts/validate_contracts.py`：校验所有 Schema 和样例。

## 核心约定

- `schema_version` 当前固定为 `1.0`；
- 时间长度统一使用整数秒，字段后缀为 `_sec`；耗时指标统一使用整数毫秒，字段后缀为 `_ms`；
- 所有绝对时间使用带时区的 RFC 3339 字符串；
- Parser 只输出 `device_type`、模式、温度与容量要求，不输出具体 `device_id`；
- 具体设备和人工资源由调度器在排程响应的 `assigned_resources` 中分配；
- `target_ready_at` 是软目标，不能单独造成输入不可行；
- 已完成或已开始且锁定的任务在重排中不得被移动；
- `finish_spread_sec` 表示各菜品最后一个必需任务完成时间的最大值减最小值；
- 连续人工操作的合并间隔默认 30 秒，可由 `manual_merge_gap_sec` 配置。

## 版本兼容规则

以下改动可在 `1.x` 中向后兼容发布：

- 增加非必填字段；
- 增加新的样例、错误码或文档；
- 放宽不影响既有有效载荷的约束。

以下改动必须升级主版本并提供迁移说明：

- 删除或重命名字段；
- 新增必填字段；
- 修改字段类型、单位或语义；
- 删除枚举值或改变既有枚举含义。

在 `1.0` 冻结后，新增枚举值也必须先做消费方兼容性 Review，避免前端或算法使用穷举分支时崩溃。

## 本地校验

```bash
python -m pip install 'jsonschema[format]>=4.23,<5'
python scripts/validate_contracts.py
```

## TypeScript 类型

前端或外部交互模块可从 Schema 生成类型，不手写重复定义：

```bash
npx json-schema-to-typescript contracts/v1/schemas/schedule-response.schema.json \
  > generated/contracts/schedule-response-v1.d.ts
```

生成产物应记录所用契约版本；Schema 更新后重新生成并运行消费方测试。
