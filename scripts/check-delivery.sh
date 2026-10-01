#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
failures=0
PYTHON_BIN="${COOKFLOW_PYTHON:-python3}"
if [[ -x .venv/bin/python ]]; then PYTHON_BIN=.venv/bin/python; fi

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }

command -v "$PYTHON_BIN" >/dev/null 2>&1 && pass "Python 可用：$PYTHON_BIN" || fail "缺少 Python：$PYTHON_BIN"
command -v node >/dev/null 2>&1 && pass 'node 可用' || fail '缺少 node'
command -v npm >/dev/null 2>&1 && pass 'npm 可用' || fail '缺少 npm'

if [[ -f scripts/validate_contracts.py ]]; then
  if "$PYTHON_BIN" scripts/validate_contracts.py; then pass 'V1 合同校验'; else fail 'V1 合同校验失败（请安装 backend/requirements*.txt）'; fi
fi

if [[ -d backend && -f backend/requirements.txt ]]; then
  if PYTHONPATH=backend:. "$PYTHON_BIN" -m pytest -q backend/tests tests; then pass '后端与仓库测试'; else fail '后端与仓库测试失败（请安装 pytest 与 backend/requirements*.txt）'; fi
else
  fail '缺少后端工程或依赖文件'
fi

if [[ -d frontend && -f frontend/package.json ]]; then
  if (cd frontend && npm ci --ignore-scripts && npm run build); then pass '前端类型检查与构建'; else fail '前端构建失败'; fi
else
  fail '缺少前端控制台或 package.json'
fi

for required in delivery/README.md delivery/demo-checklist.md CONTRIBUTING.md .github/merge-policy.md; do
  [[ -f "$required" ]] && pass "交付文档：$required" || fail "缺少交付文档：$required"
done

if (( failures > 0 )); then
  printf '\n交付检查失败：%d 项。\n' "$failures" >&2
  exit 1
fi
printf '\n交付检查通过。\n'
