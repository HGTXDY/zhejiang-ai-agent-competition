# 灶序 CookFlow 前端演示控制台

这是 CookFlow 的可运行 React/TypeScript 产品控制台。当前初始排程已经可以通过 HTTP API 适配器联调；事件上报、动态重排仍保留 Mock 降级路径。

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
- 临时加菜 Mock 流程；
- 事件通知面板；
- 重排差异展示（当前以 Mock 结果演示）；
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

当前后端已提供 `schedule-request` → `schedule-response` 初始排程闭环；事件上报和 `replan-response` 尚未由 API 暴露，因此这些操作在 HTTP 模式下仍明确走 Mock，不代表动态重排后端已完成。
