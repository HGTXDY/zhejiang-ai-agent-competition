# Agent 架构记录

当前产品基线为“灶序智能烹饪调度 Agent”。详细设计见：

- [PRD 基线](docs/product/PRD_BASELINE.md)
- [技术架构设计](docs/technical/TECHNICAL_ARCHITECTURE.md)
- [数据模型与 API 契约](docs/technical/DATA_AND_API_CONTRACT.md)
- [模块分工](docs/project/MODULE_OWNERSHIP.md)
- [决策权与变更流程](docs/project/DECISION_RIGHTS.md)
- [开发路线](docs/project/ROADMAP.md)

## 核心原则

```text
自然语言菜谱
    ↓
大模型结构化解析
    ↓
Schema 与业务规则校验
    ↓
OR-Tools CP-SAT 确定性调度
    ↓
排程、指标、甘特图与通知
    ↓
事件状态与最小扰动重排
```

大模型负责语义理解，不能直接决定正式排程；硬约束由规则层和求解器保证。
