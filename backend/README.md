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
