# 执行状态机与重排边界（V1）

`backend/app/execution/state_machine.py` 只负责事件状态迁移和不可移动任务保护，不在本模块内求解新排程。

## 事件处理

支持 V1 的四类事件：

- `TASK_COMPLETED`：任务变为 `COMPLETED` 并锁定；依赖它的后续任务列入重排影响范围；
- `TASK_DELAYED`：可移动任务变为 `DELAYED`，返回受影响后继任务；具体时间调整由重排器完成；
- `DEVICE_UNAVAILABLE`：占用该设备且尚未锁定的任务变为 `EXCEPTION`；已完成、运行中或显式锁定任务不被修改；
- `DISH_ADDED`：原子添加新的 `PENDING` 任务，重复任务 ID 或批次内重复会整体拒绝。

## 锁定规则

以下任务不能被延迟或重排修改：

```text
locked = true
status = RUNNING
status = COMPLETED
status = LOCKED
```

事件具有幂等保护：同一个 `event_id` 只能成功应用一次，错误会返回稳定错误码。

## 与重排器的边界

状态机返回 `affected_task_ids`，重排服务后续应：

1. 保留已完成和锁定任务的开始时间、结束时间及资源；
2. 只将可移动任务交给调度器；
3. 对比重排前后排程，生成 `changes` 和 `disruption_metrics`；
4. 无解、超时或事件冲突时返回结构化错误，不伪造新排程。
