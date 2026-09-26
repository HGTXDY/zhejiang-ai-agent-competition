# 灶序 CookFlow 前端演示控制台

这是 PR #14 的第一版可视化产品壳，用于在后端 API 完成前演示排程、资源轨道和执行事件交互。

## 本地运行

```bash
cd frontend
npm install
npm run dev
```

打开 `http://localhost:5173`。

## 当前范围

- 排程总览指标；
- 设备/操作员资源轨道甘特图；
- 任务队列和选中任务详情；
- 完成任务、上报延迟、设备异常等 Mock 事件；
- 明确 API 接入边界，当前 Mock 数据位于 `src/mock/schedule.ts`。

## API 接入原则

后续接入后端时，保留 `src/types/contracts.ts` 的字段命名，替换 Mock 数据层，不在组件中重新定义 V1 契约。真实 API 需要接入 `schedule-response`、`event-request` 和 `replan-response`。
