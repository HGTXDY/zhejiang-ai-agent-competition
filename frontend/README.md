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

## Issue #60：真实产品前半段

选菜 → 配置厨房 → 解析确认 → 初始排程现在通过独立的 `src/api/product.ts`
调用真实 `/recipes`、`/recipes/{id}`、`/recipes/parse`、`/devices/validate`、`/schedules`。
前半段始终使用 HTTP，`VITE_API_BASE_URL` 默认 `http://127.0.0.1:8000`；
连接失败显示错误，可重试加载菜谱，不回退到 Mock。后端与前端须同时启动。

- 菜谱选择限制 3～5 道；逐个取得完整 Recipe 后才提交解析。
- 确认页展示真实任务、时长、设备能力要求、字段来源和可用置信度。
  用户勾选确认后才提交；`missing` 字段阻止提交，暂不提供字段补录。
- 每个灶眼/蒸箱/烤箱独立映射为设备实例。当前能力使用界面注明的固定预设，
  模式、温度范围及容量与当前 Parser 的标准演示预设对齐；不依据菜谱要求自动扩充设备能力。其他四类设备尚不能配置。
- 目标时刻取浏览器本地时区下一次到达该时刻，提交带时区的 ISO 时间。
- 只发送 V1 字段，保留 Parser 的任务依赖及来源；任务名称从请求按 task_id
  映射回返回排程，不向后端发送 UI 字段。
- 生成阶段重新校验厨房；校验失败、求解超时/不可行、网络错误均阻止进入结果页。

执行页及 `src/api/client.ts` 保持原样。这次只保证真实初始排程进入现有执行页。
现有执行适配器仍受 `VITE_API_MODE` 控制，HTTP 重排仍使用自己的 demo 请求上下文；
等待执行交互 PR 合并后应统一真实 request/schedule 会话。当前请仅验收初始排程，
不要将后续执行事件当作已完成的真实闭环。

```bash
npm run build
npm test
```

可选真实后端联调测试（先启动后端；默认 `npm test` 跳过此项）：

```powershell
$env:VITE_PRODUCT_LIVE_API_URL = 'http://127.0.0.1:8000'
npm test
Remove-Item Env:VITE_PRODUCT_LIVE_API_URL
```

联调测试从官方列表挑选 3 道兼容固定预设且无缺失字段的菜谱，
只验收设备校验与初始排程，不代表全部 100 道菜都可在当前厨房配置下执行。

设备预设保存在 `src/api/device-profiles.json`，直接对照当前
`backend/app/parser/deterministic.py` 的 `_MODE_TABLE` 与 `default_device_config` 维护。
新增回归测试检查每种设备的全部标准模式，以及温度范围和容量；
Parser 更新后如果预设未同步，前端测试会失败。实际设备可能不支持完整演示预设，
用户须确认页面说明；当前版本不提供真实设备型号与自定义能力配置。
