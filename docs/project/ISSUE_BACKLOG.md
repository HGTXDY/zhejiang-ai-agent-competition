# 首批 Issue 拆分

| ID | 标题 | 里程碑 | 主责 | 依赖 |
|---|---|---|---|---|
| [T-001](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/2) | 冻结领域 Schema 与枚举 | M0 | HGTXDY | 无 |
| [T-002](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/3) | 制作四道菜固定标注数据 | M0 | cbiiro97977 | T-001 草案 |
| [T-003](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/4) | 初始化 Python/FastAPI 工程与质量工具 | M1 | HGTXDY | [T-001](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/2) |
| [T-004](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/5) | 初始化 React/TypeScript 工程与质量工具 | M1 | cbiiro97977 | API 示例 |
| [T-005](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/6) | 实现设备能力、DAG 和输入校验器 | M1 | HGTXDY | T-001、T-002 |
| [T-006](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/7) | 实现 CP-SAT 基础调度器 | M1 | HGTXDY | [T-005](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/6) |
| [T-007](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/8) | 实现基础资源轨道甘特图 | M1 | cbiiro97977 | 排程示例 |
| [T-008](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/9) | 建立 M1 自动验收与集成测试 | M1 | 共同 | T-006、T-007 |
| [T-009](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/10) | 设计 Parser Adapter 与结构化 Prompt | M2 | cbiiro97977 | [T-001](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/2) |
| [T-010](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/11) | 建立菜谱解析标注集和字段评测 | M2 | cbiiro97977 | T-002、T-009 |
| [T-011](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/12) | 实现多目标指标与分层优化 | M3 | HGTXDY | [T-006](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/7) |
| [T-012](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/13) | 实现执行状态和最小扰动重排 | M4 | HGTXDY | T-006、T-011 |
| [T-013](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/14) | 实现执行页面、事件上报和重排差异 | M4 | cbiiro97977 | T-007、T-012 API |
| [T-014](https://github.com/HGTXDY/zhejiang-ai-agent-competition/issues/15) | 完成 Docker、性能测试和比赛交付包 | M5 | 共同 | 全部 P0 |
