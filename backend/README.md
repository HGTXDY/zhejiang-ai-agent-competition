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

错误响应遵循 `error.schema.json`。当前 API 已提供确定性调度闭环；真实 Parser、动态重排和前端 HTTP 联调仍在后续 Issue 中实现。
