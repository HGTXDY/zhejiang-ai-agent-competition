# 项目治理、模块分工与执行边界

## 1. 决策机制

本项目采用“小团队负责人制”，避免双人团队在核心方向上反复等待共识。

- **HGTXDY 是项目负责人和技术负责人**，负责最终产品范围、优先级、架构、数据契约、技术路线、任务分配和版本验收。
- **cbiiro97977 是协作研发成员**，按照已冻结的需求、接口和验收标准完成被分配的模块，并及时反馈实现风险。
- 重要决定由 HGTXDY 在 Issue、PR 或 ADR 中记录后生效；cbiiro97977 可以提出建议和风险，但不承担方向决策责任。
- 实现过程中如发现需求冲突、接口不可实现或工作量明显超出预期，应先在对应 Issue 中说明，不自行改变需求范围和公共接口。

这里的负责人制不意味着跳过工程质量。所有代码仍需经过测试和 Review；Review 用于发现缺陷和接口问题，最终范围及方案由项目负责人确认。

## 2. 角色职责

### 2.1 HGTXDY：项目负责人 / 核心研发

负责：

- PRD 基线、优先级和版本范围；
- 系统架构、技术选型和 ADR；
- 领域 Schema、API 契约和公共接口；
- 菜谱解析器及大模型 Prompt；
- 设备模型、规则校验和 OR-Tools 调度器；
- 多目标优化、执行状态和动态重排；
- FastAPI、数据库、Docker、CI 和性能；
- GitHub 任务分配、合并和版本验收；
- 最终比赛交付。

### 2.2 cbiiro97977：前端与数据执行研发

负责：

- 按既定 Schema 制作和维护固定菜谱数据；
- 菜谱字段标注、错误样例和测试 fixture；
- React/TypeScript 前端工程；
- 菜品选择、设备配置、排程结果和执行页面；
- ECharts 资源轨道甘特图；
- 动态重排差异和通知展示；
- 前端组件测试、页面验收材料和演示素材；
- 按项目负责人提供的评测规则执行数据核对。

不要求其独立决定：后端架构、调度算法、Prompt 策略、公共 Schema、API 变更、优先级和发布范围。

## 3. 模块主责表

| 模块 | 决策/主责 | 执行协作 | 最终验收 |
|---|---|---|---|
| 产品范围与优先级 | HGTXDY | cbiiro97977 提供风险反馈 | HGTXDY |
| 架构、技术栈与 ADR | HGTXDY | cbiiro97977 提供实现反馈 | HGTXDY |
| 领域 Schema 与 API | HGTXDY | cbiiro97977 按契约接入 | HGTXDY |
| 大模型解析与 Prompt | HGTXDY | cbiiro97977 提供标注数据 | HGTXDY |
| 规则校验与调度器 | HGTXDY | cbiiro97977 提供验收样例 | HGTXDY |
| 动态重排与性能 | HGTXDY | cbiiro97977 完成前端接入 | HGTXDY |
| FastAPI、Docker 与 CI | HGTXDY | cbiiro97977 验证前端环境 | HGTXDY |
| 固定菜谱数据和标注 | cbiiro97977 | HGTXDY 定义 Schema 与抽查 | HGTXDY |
| React 页面与状态管理 | cbiiro97977 | HGTXDY 提供 API 与验收标准 | HGTXDY |
| ECharts 甘特图 | cbiiro97977 | HGTXDY 提供排程数据 | HGTXDY |
| 演示素材和页面验收 | cbiiro97977 | HGTXDY 提供演示流程 | HGTXDY |

## 4. 协作成员的工作输入

HGTXDY 在交付任务前应提供：

- 对应 GitHub Issue；
- 已冻结的输入输出契约；
- 示例数据或 mock；
- 明确的完成标准；
- 前置依赖和禁止变更范围。

如果上述信息不足，任务保持 `status:blocked`，不要求协作成员自行补齐产品或架构决策。

## 5. 协作成员的工作输出

cbiiro97977 完成任务时应提供：

- 对应功能代码和测试；
- 运行方式；
- 页面任务附截图或录屏；
- 数据任务附校验结果；
- 已知限制和未完成项；
- 不擅自修改公共 Schema、API 和验收标准。

## 6. 第一阶段分工

### 6.1 HGTXDY：先冻结公共契约

1. 冻结 Task、Device、Schedule Schema；
2. 给出 `schedule-request-v1.json` 和 `schedule-response-v1.json`；
3. 确定四道菜标注模板；
4. 初始化后端工程；
5. 实现校验器和基础调度器。

### 6.2 cbiiro97977：在契约冻结后执行

1. 按模板制作四道菜固定数据；
2. 初始化 React/TypeScript 工程；
3. 使用负责人提供的 mock 排程开发基础甘特图；
4. 编写前端组件测试；
5. 提交截图和验收记录。

### 6.3 第一阶段集成

HGTXDY 提供真实排程 API 后，cbiiro97977 将 mock 替换为 API。若契约保持兼容，甘特图核心组件不应重写。集成完成后由 HGTXDY 按 M1 验收标准作最终确认。

## 7. Review 与合并规则

- 项目方向、任务拆分和决策文档由 HGTXDY 最终批准；
- cbiiro97977 的实现 PR 由 HGTXDY Review 和合并；
- HGTXDY 的核心代码 PR 应包含自动测试，并可邀请 cbiiro97977 做可执行性检查，但最终技术决策仍由 HGTXDY 作出；
- 公共 Schema 和 API 的修改必须先由 HGTXDY 更新契约，再分配下游适配任务；
- 不允许协作成员直接向 `main` 推送或绕过 Issue 扩大需求。
