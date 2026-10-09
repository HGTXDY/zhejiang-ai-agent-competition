# CookFlow 后端

## 本地启动 API

在仓库根目录执行：

```bash
python -m pip install -r backend/requirements.txt
uvicorn app.main:app --app-dir backend --reload
```

健康检查：

```bash
curl http://127.0.0.1:8000/health
```

调度接口：

```text
POST /v1/schedules
```

请求体使用 `contracts/v1/schemas/schedule-request.schema.json`，接口会依次执行：

```text
JSON Schema 校验 → 业务规则校验 → CP-SAT 排程 → V1 schedule-response
```

错误响应遵循 `error.schema.json`。当前 API 已提供确定性初始调度闭环与事件驱动动态重排
（`POST /v1/replans`、`/schedules/{schedule_id}/events`、`/schedules/{schedule_id}/replan`）。
菜谱解析默认走确定性规则解析器，通过 `POST /recipes/parse?provider=llm` 可切换到 LLM 解析
适配器（需配置 `MODEL_BASE_URL` / `MODEL_API_KEY` / `MODEL_NAME`，见 `.env.example`）。
Agent 对话入口 `POST /agent/plan` 也使用同一套 OpenAI-compatible 模型配置；模型负责理解多轮需求并输出受控 JSON，后端会把菜品重新限制到官方菜谱目录，再交给设备校验和 CP-SAT 排程。未配置模型时不会静默使用 Agent Mock，而是返回配置错误。系统提示词位于 `backend/app/agent_prompts/system.txt`，采用“权威信息 → 处理流程 → 字段规则 → JSON 合同”的结构。

## 可选：提前准备与当天烹饪分区（Fix 04）

标准 `/v1/schedules` 和 `/schedules` **不变**。产品端如需按阶段展示，可调用
`POST /schedules/staged`，请求体是一个 JSON 对象，包含 `schedule_request`（完整的 V1
`schedule-request.schema.json` 对象）和 `confirmed_advance_task_ids`（字符串数组，
可省略，默认空数组）。真实构造例子可参考
`backend/tests/test_staged_api.py::sample_request`。

其中 `confirmed_advance_task_ids` 默认 `[]`。API 仅自动拆分依赖明确、长时间且
可安全提前的冷藏或冷冻步骤；含糊时长、保存条件不明确的步骤会返回 `review_required`，
不会虚构持续时间。`advance_schedule` 和 `main_schedule` 是分别使用原 CP-SAT
求出的完整阶段计划，所有步骤及真实持续时长均保留。

`timing` 明确区分 **三个真实口径**：

- `advance_makespan_sec`：提前准备阶段历时（包含 24 小时冷冻等真实等待）。
- `main_makespan_sec`：正式烹饪阶段历时；只表示当天要做的部分。
- `total_elapsed_sec`：**从最早的提前准备开始到全部菜品完成的整体历时**，
  不因页面分区而扣掉 24 小时。两个阶段刻意顺序安排，整体历时等于两阶段
  makespan 之和；每阶段内部可并行任务不会被逐项累加。

`suggested_advance_start_at`、`suggested_main_start_at` 和
`advance_finish_by` 使用同一个带时区的 `target_ready_at` 倒排。对应的
`advance_start_offset_sec`、`main_start_offset_sec`、`total_finish_offset_sec`
可供前端在不扭曲时间轴的前提下分段绘图。

未完成的提前任务出现在 `pending_advance_task_ids`，这时
`can_start_main=false`、`executable_main_request=null`，正式烹饪计划仅供预览。
必须由用户显式确认提前准备已完成后才允许开始正式阶段。不会静默将提前任务
标记为完成，也不改变官方 V1 接口的评分数据或动态重排语义。

该产品分阶段接口目前未接入 P3 页面；后续独立前端 Fix 会展示“整体历时／
提前准备／正式烹饪”三个指标。分阶段规划会运行两次求解，端到端耗时可能
高于单次官方初始排程；不能将阶段结果冒充官方 V1 全任务优化指标。
