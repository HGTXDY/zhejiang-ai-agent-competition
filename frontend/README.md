# 灶序 CookFlow 前端演示控制台

这是 CookFlow 的第一阶段可运行产品原型，目标是在后端 API 完成前提供可演示、可 Review 的排程控制台。

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
- `src/mock/api.ts` 作为真实 API 的替换边界。

## 校验

```bash
npm run build
```

`build` 会先执行 TypeScript 类型检查，再执行 Vite 生产构建。

## API 接入原则

后续接入后端时，保留 `src/types/contracts.ts` 的字段命名，替换 Mock 数据层，不在组件中重新定义 V1 契约。真实 API 需要接入 `schedule-response`、`event-request` 和 `replan-response`。当前按钮交互仍是前端 Mock，不代表真实后端闭环。
