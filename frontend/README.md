# 灶序 CookFlow 前端演示控制台

这是 CookFlow 的可运行 React/TypeScript 产品控制台。初始排程、事件上报和动态重排均已支持 HTTP API 适配器；Mock 仍作为默认的离线演示模式。

## 本地运行

```bash
cd frontend
npm install
npm run dev
```

打开 `http://localhost:5173`。

## 当前原型范围

- 排程总览指标与任务进度；
- 设备/操作员资源轨道甘特图；
- 按资源、任务状态筛选；
- 锁定任务可视化与执行任务详情；
- 完成任务、上报延迟、设备异常等事件上报；
- 临时加菜与动态重排流程（HTTP 模式走真实 `/v1/replans`，Mock 模式走本地 fixture）；
- 事件通知面板；
- 重排差异、结构化通知和扰动指标展示；
- `src/api/client.ts` 是 API 边界：通过 `VITE_API_MODE=http` 使用后端初始排程接口，默认 `mock` 用于离线演示。

## 校验

```bash
npm run build
```

`build` 会先执行 TypeScript 类型检查，再执行 Vite 生产构建。

## API 接入原则

保留 `src/types/contracts.ts` 的字段命名，组件不得重新定义 V1 契约。启动 HTTP 模式：

```bash
VITE_API_MODE=http VITE_API_BASE_URL=http://127.0.0.1:8000 npm run dev
```

当前后端已提供 `schedule-request` → `schedule-response` 初始排程闭环；事件上报、临时加菜和动态重排接入 `POST /v1/replans`（`replan-response`）。

## Execution integration

The execution dashboard supports both modes:

- `VITE_API_MODE=mock` (default): uses the deterministic V1 fixture and mock replan responses.
- `VITE_API_MODE=http`: loads `public/demo/schedule-request.json`, calls `POST /v1/schedules`, and sends execution events to `POST /v1/replans`.
- `VITE_API_BASE_URL` controls the FastAPI origin and defaults to `http://127.0.0.1:8000`.

Run the real API locally for the HTTP integration demo:

```bash
# backend
PYTHONPATH=backend uvicorn app.api:app --reload --port 8000

# frontend
VITE_API_MODE=http VITE_API_BASE_URL=http://127.0.0.1:8000 npm run dev
```

The UI never calculates a new schedule. It sends the current schedule and the V1 event envelope to the API, then renders the returned schedule, changes, notifications, and disruption score.

## Issue #60 / PR #61：产品流程与执行上下文

`VITE_API_MODE=http` 时，前半段通过 `/recipes`、`/recipes/{id}`、`/recipes/parse`、`/devices/validate`、`/schedules` 使用真实后端。连接失败显示错误，不静默切换 Mock。

未设置模式或使用 `VITE_API_MODE=mock` 时，选菜、配置、解析确认、初始排程和结果展示均复用 `src/mock/`，无需启动后端。确认页明确标记离线演示，Mock 不调用真实 Parser 或 CP-SAT。界面显示当前模式。

厨房配置支持七类设备。标准演示 profiles 从当前 Parser 的模式表及 `default_device_config` 提取；测试显式断言七种类型，与契约、Parser 全量模式、温度（含 null）和容量对照。实际设备仍需用户确认支持这些标准预设，数量为 0 表示不可用。

HTTP 初始排程成功后，App 将同一次 `ScheduleRequest` 交给执行 API 的 `setScheduleRequest`；后续 `/v1/replans` 使用该请求。缺少或不匹配上下文会明确报错，不再自动加载 Demo 请求。独立调用 `getSchedule()` 仍是显式的 Demo 入口。

验证：`npm run build`、`npm test`。真实后端启动后，可设置 `VITE_PRODUCT_LIVE_API_URL=http://127.0.0.1:8000` 并运行 `npm test`，执行官方 3/5 道菜的初始排程及延迟重排测试。默认测试跳过这些网络联调测试，不代表联调通过。

- 菜谱选择限制 3～5 道；HTTP 逐个取得完整 Recipe 后才提交解析。
- HTTP 确认页展示真实任务、时长、设备要求及字段来源；用户勾选确认后才提交，`missing` 字段仍阻止提交，暂不支持补录。
- 每个设备实例使用独立 ID，不按所选菜谱自动扩充能力。目标时刻取本地时区下一次到达，提交带时区的 ISO 时间。
- 生成阶段重新校验厨房；校验失败、求解超时/不可行、网络错误均阻止进入结果页。

可选联调（先启动后端，再于 `frontend` 目录执行）：

```powershell
$env:VITE_PRODUCT_LIVE_API_URL = 'http://127.0.0.1:8000'
npm test
Remove-Item Env:VITE_PRODUCT_LIVE_API_URL
```

联调选取无缺失字段且兼容当前厨房的官方菜谱，验证初始排程和延迟重排，不代表所有 100 道菜均可执行或全部执行事件已验收。设备 profiles 使用 Parser 标准演示能力，暂不提供型号发现或自定义能力配置。
