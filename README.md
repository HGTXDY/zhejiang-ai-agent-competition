# 浙江省大学生人工智能竞赛 Agent 项目

本仓库用于浙江省大学生人工智能竞赛的双人协作开发。当前阶段先建立工程规范、协作流程和可复用的 Agent 项目骨架；比赛主题确定后，再基于本规范拆解需求与实现方案。

## 当前状态

- 项目阶段：预研与工程准备
- 参赛主题：待确定
- 协作方式：Issue → 分支 → Pull Request → Code Review → 合并
- 仓库权限：Private

## 目录结构

```text
.
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.md
│   │   ├── feature_request.md
│   │   └── research_task.md
│   ├── pull_request_template.md
│   └── workflows/                 # CI 工作流（主题确定后补充）
├── docs/
│   ├── meeting-notes/             # 会议记录
│   └── decisions/                 # 技术决策记录（ADR）
├── src/                           # 业务代码
├── tests/                         # 自动化测试
├── .env.example                   # 环境变量示例，禁止放真实密钥
├── ARCHITECTURE.md                # 系统架构与 Agent 设计
├── CONTRIBUTING.md                # 协作开发规范
├── DEVELOPMENT.md                 # 日常开发流程
├── REQUIREMENTS.md                # 需求池与验收标准
└── README.md
```

## 快速开始

主题和技术栈确定后，在本文件补充：运行环境、依赖安装、启动命令、测试命令和部署方式。所有本地密钥只放在未提交的 `.env` 中，并以 `.env.example` 说明变量名称和用途。

## 重要约定

1. 不直接向 `main` 分支推送代码。
2. 每项工作先创建 Issue，再创建对应分支。
3. 所有合并必须经过 Pull Request 和至少一次 Code Review。
4. Prompt、工具调用、模型参数和评测数据都需要版本化记录。
5. 不提交 API Key、个人隐私数据、比赛未公开材料或大体积生成文件。
