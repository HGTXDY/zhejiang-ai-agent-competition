# 产品研发 Issue Backlog

## 当前执行

两位研发同时只各推进一个主任务，减少上下文切换和分支冲突。

| ID | 标题 | 当前负责人 | 状态/边界 |
|---|---|---|---|
| [T-001](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/2) | 冻结领域 Schema、枚举与版本规则 | HGTXDY | 主线；只修改契约、样例和契约文档 |
| [T-003](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/4) | 初始化 Python/FastAPI 后端工程与质量基线 | cbiiro97977 | 并行小任务；不定义业务 Schema |

## 待派发任务池

下列 Issue 不预先绑定长期负责人。HGTXDY 根据依赖和当前负载逐个派发；cbiiro97977 可以承担数据、后端或算法模块，不限定为前端角色。

| ID | 标题 | 里程碑 | 前置条件 | 建议并行边界 |
|---|---|---|---|---|
| [T-002](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/3) | 制作四道菜固定标注数据 | M0 | T-001 契约样例 | 只修改 fixture/标注目录 |
| [T-004](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/5) | 初始化 React/TypeScript 工程 | M1 | API Mock | 可独立使用契约样例 |
| [T-005](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/6) | 实现设备能力、DAG 和输入校验器 | M1 | T-001 | 可拆成设备校验与 DAG 校验两个独立子模块 |
| [T-006](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/7) | 实现 CP-SAT 基础调度器 | M1 | T-005 | 主调度器；公共接口以契约为准 |
| [T-007](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/8) | 实现基础资源轨道甘特图 | M1 | 排程 Mock | 不等待真实求解器 |
| [T-008](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/9) | 建立 M1 自动验收与集成测试 | M1 | T-006 | 测试代码与算法实现分目录 |
| [T-009](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/10) | 设计 Parser Adapter 与结构化 Prompt | M2 | T-001 | Parser 与调度器通过 Task 契约隔离 |
| [T-010](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/11) | 建立菜谱解析标注集和字段评测 | M2 | T-001、T-002 | 标注和评测工具可独立开发 |
| [T-011](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/12) | 实现多目标指标与分层优化 | M3 | T-006 | 指标计算可先于优化策略独立实现 |
| [T-012](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/13) | 实现执行状态和最小扰动重排 | M4 | T-006、T-011 | 后端事件/算法，不包含执行交互页面 |
| [T-014](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/15) | Docker、性能测试与产品交付包 | M5 | 产品 P0 | 不包含演示材料 |

## 外部成员范围

| ID | 内容 | 说明 |
|---|---|---|
| [T-013](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/14) | 执行页面、事件上报与重排差异展示 | 由其他成员负责；当前两位研发只提供 API 契约和样例 |
| 未建/另行管理 | 演示文案、PPT、录屏和路演材料 | 由其他成员负责，不计入产品研发工作量 |

## 派发准则

每次派发给 cbiiro97977 的任务必须同时满足：

1. 输入输出已有冻结契约或明确 Mock；
2. 与 HGTXDY 当前分支的主要写入目录不重叠；
3. 可以独立运行测试并给出验收证据；
4. 不依赖尚未合并的私有分支；
5. PR 由 HGTXDY Review，同时 HGTXDY 的主线 PR 由 cbiiro97977 Review。
