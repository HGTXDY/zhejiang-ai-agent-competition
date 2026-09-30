# 开发流程

## 本地环境

后端使用 Python 3.12，前端使用 Node.js 20。首次配置：

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
cd frontend && npm ci
```

本地密钥只放在未提交的 `.env` 中，并以 `.env.example` 记录变量名称和用途。

## 日常开发

1. 从最新 `main` 创建 `feature/`、`fix/`、`docs/` 或 `chore/` 分支；
2. 在 Issue 中明确目标、优先级、负责人、写入范围和验收标准；
3. 实现时同步补测试、契约和文档；
4. 提交 PR，填写变更、测试、风险和关联 Issue；
5. CI 通过并完成另一位研发 Review 后，由负责人合并；
6. 合并后在 `main` 上执行全量测试并关闭 Issue。

## 本地门禁

```bash
git diff --check
python scripts/validate_contracts.py
PYTHONPATH=backend:. python -m pytest -q
(cd frontend && npm run build)
./scripts/check-delivery.sh
```

重要架构或方案选择写入 `docs/decisions/`；会议结论写入 `docs/meeting-notes/`。
