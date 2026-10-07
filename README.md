# 灶序（CookFlow）智能烹饪调度 Agent

浙江省大学生人工智能竞赛“方太”人工智能专项赛项目。灶序面向家庭多人、多菜并行烹饪场景，把自然语言菜谱和厨房设备约束转换为可执行、可解释、可动态重排的烹饪计划。

> 当前产品主题、PRD 和赛题范围已经冻结，不再是通用 Agent 脚手架项目。

## 产品目标

用户选择菜谱并配置厨房设备后，系统完成：

1. 菜谱步骤结构化与字段状态标注；
2. Schema 与业务规则校验；
3. 基于 OR-Tools CP-SAT 的确定性设备/人工调度；
4. 输出任务队列、资源轨道、指标和可解释的排程结果；
5. 在延迟、设备不可用、临时加菜等事件发生时，保持已完成/锁定任务并进行最小扰动重排。

大模型只负责语义解析和结构化抽取，不能绕过契约、规则校验和调度器直接决定正式排程。

## 当前基线

- 产品：灶序智能烹饪调度 Agent
- 赛题：ZX-2026-0302 智能烹饪调度 Agent
- PRD：V1.0，已评审冻结（2026-09-24）
- 当前里程碑：M1 确定性调度 MVP，向 M2/M3/M4 迭代
- 协作：HGTXDY 与 cbiiro97977 对等开发、交叉 Review；HGTXDY 负责维护任务池和推进顺序

## 仓库结构

```text
contracts/v1/       版本化 JSON Schema、样例和业务规则
fixtures/v1/        确定性调度与负向验收 fixture
backend/app/
  parser/           菜谱结构化解析适配器
  validation/       请求/结果校验与设备能力判断
  scheduler/        OR-Tools CP-SAT 调度器
  execution/        执行状态机、事件和重排差异
  metrics/          多目标指标
  api.py            FastAPI API 入口
backend/tests/      后端、调度、API、状态机和指标测试
frontend/            React + TypeScript 产品原型与排程可视化
data/               标注模板、评测数据和数据说明
docs/product/       PRD 基线
docs/competition/   官方赛题材料说明
docs/project/       backlog、路线、分工和决策权
docs/technical/     架构、契约和算法文档
delivery/           交付检查与现场演示清单
scripts/             契约校验、评测、演示和交付脚本
```

## 快速开始

### 后端

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
PYTHONPATH=backend:. python -m pytest -q
PYTHONPATH=backend:. uvicorn app.main:app --app-dir backend --reload
```

API 文档启动后位于 `/docs`；健康检查位于 `/health`。固定请求样例见 `fixtures/v1/four-dish-normal.json`。

### 前端

```bash
cd frontend
npm ci
npm run build
npm run dev
```

前端当前提供产品主流程和排程可视化；接口适配支持 Mock 与 HTTP 模式，具体配置见 `frontend/README.md`。

### 模型配置

HTTP 模式下可点击页面右上角的“规则解析 / AI · 模型名”进入模型设置。系统支持 OpenAI-compatible Chat Completions 的 `Base URL + API Key + Model` 配置、连接测试和规则/AI 解析切换。API Key 不会通过查询接口返回，也不会写入浏览器存储；页面保存的配置仅在当前后端进程内生效。

生产或比赛部署仍建议通过根目录 `.env` 注入：

```bash
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_API_KEY=...
MODEL_NAME=gpt-4o-mini
MODEL_PARSER_PROVIDER=deterministic  # 确认配置可用后可改为 llm
```

模型只参与菜谱语义结构化，输出仍须经过 Schema、业务规则、设备能力校验和 CP-SAT 调度。未配置模型时默认使用确定性规则解析，不影响完整演示链路。

### 交付检查

在仓库根目录执行：

```bash
./scripts/check-delivery.sh
```

该脚本会执行契约校验、后端测试、前端构建和交付文档检查。演示启动：

```bash
./scripts/run-demo.sh
```

## CI 与合并门禁

每个 Pull Request 至少经过以下自动检查：

- `quality-gate`：完整后端测试、契约校验、前端构建；
- `api`：FastAPI API 测试；
- `scheduler`：调度器及后端回归测试；
- `parser`：解析适配器测试；
- `execution`：执行状态机测试；
- `metrics`：多目标指标测试；
- `annotation`：标注流水线测试；
- `frontend`：TypeScript 检查与 Vite 构建；
- `repository-policy`：敏感文件和高风险凭据扫描。

任何代码、Prompt、配置、契约或文档变更都必须通过工作分支 → PR → 双人交叉 Review → CI → 合并，禁止直接向 `main` 推送。详细规则见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [.github/merge-policy.md](.github/merge-policy.md)。

## 核心文档

- [PRD 基线](docs/product/PRD_BASELINE.md)
- [官方赛题说明](docs/competition/README.md)
- [技术架构](docs/technical/TECHNICAL_ARCHITECTURE.md)
- [数据与 API 契约](docs/technical/DATA_AND_API_CONTRACT.md)
- [开发路线](docs/project/ROADMAP.md)
- [Issue Backlog](docs/project/ISSUE_BACKLOG.md)
- [模块分工](docs/project/MODULE_OWNERSHIP.md)
- [开发流程](DEVELOPMENT.md)
- [交付演示清单](delivery/demo-checklist.md)
