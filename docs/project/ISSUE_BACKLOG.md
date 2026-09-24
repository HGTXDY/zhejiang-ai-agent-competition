# 产品研发 Issue Backlog

## 当前执行

> 当前阶段所有 P0 产品能力均由两位研发共同实现；外部成员只负责成品后的 PPT、录屏和路演材料。

两位研发同时只各推进一个主任务，减少上下文切换和分支冲突。

| ID | 标题 | 当前负责人 | 状态/边界 |
|---|---|---|---|
| [T-001](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/2) | 冻结领域 Schema、枚举与版本规则 | HGTXDY | 主线；只修改契约、样例和契约文档 |
| [T-003](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/4) | 初始化 Python/FastAPI 后端工程与质量基线 | cbiiro97977 | #6 校验核心的工程起点 |
| [T-004](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/5) | 产品前端主流程与 React/TypeScript 工程 | cbiiro97977 | 产品入口；使用 V1 Mock 并行开发 |

## 待派发任务池

除当前正在推进的核心线外，下列 Issue 不预先绑定长期负责人。HGTXDY 根据依赖和当前负载逐个派发；cbiiro97977 可以承担数据、后端或算法模块，不限定为前端角色。

| ID | 标题 | 里程碑 | 前置条件 | 建议并行边界 |
|---|---|---|---|---|
| [T-002](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/3) | 制作四道菜固定标注数据 | M0 | T-001 契约样例 | 只修改 fixture/标注目录 |
| [T-005](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/6) | 实现设备能力、DAG 和输入校验器 | M1 | T-001 | 包含模式/温度/容量兼容、字段来源状态和状态转换校验；可拆成设备校验与 DAG 校验两个独立子模块 |
| [T-006](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/7) | 实现 CP-SAT 基础调度器 | M1 | T-005 | 主调度器；公共接口以契约为准 |
| [T-007](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/8) | 实现基础资源轨道甘特图 | M1 | T-004、排程 Mock | 不等待真实求解器 |
| [T-008](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/9) | 建立 M1 自动验收与集成测试 | M1 | T-006 | 测试代码与算法实现分目录 |
| [T-009](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/10) | 设计 Parser Adapter 与结构化 Prompt | M3 | T-001 | Parser 与调度器通过 Task 契约隔离 |
| [T-010](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/11) | 建立菜谱解析标注集和字段评测 | M3 | T-001、T-002 | 标注和评测工具可独立开发 |
| [T-011](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/12) | 实现多目标指标与分层优化 | M2 | T-006 | 指标计算可先于优化策略独立实现 |
| [T-012](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/13) | 实现执行状态和最小扰动重排 | M4 | T-006、T-011 | 后端状态/算法；产品交互由 T-013 对接 |
| [T-013](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/14) | 产品执行交互、事件上报与重排差异展示 | M4 | T-004、T-007、T-012 API | cbiiro97977；产品必做，先用 Mock 后接真实 API |
| [T-014](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/15) | Docker、性能测试与产品交付包 | M5 | 产品 P0 | 不包含演示材料 |

## 外部成员范围

| 内容 | 说明 |
|---|---|
| 演示文案、PPT、录屏和路演材料 | 基于两位研发完成的可运行产品制作，不修改产品代码、不开发产品交互 |

## 派发准则

每次派发给 cbiiro97977 的任务必须同时满足：

1. 输入输出已有冻结契约或明确 Mock；
2. 与 HGTXDY 当前分支的主要写入目录不重叠；
3. 可以独立运行测试并给出验收证据；
4. 不依赖尚未合并的私有分支；
5. PR 由 HGTXDY Review，同时 HGTXDY 的主线 PR 由 cbiiro97977 Review。
