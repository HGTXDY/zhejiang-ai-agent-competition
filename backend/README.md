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
