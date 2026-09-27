#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
failures=0

pass() { printf 'PASS  %s\n' "$1"; }
skip() { printf 'SKIP  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }

command -v python3 >/dev/null 2>&1 && pass 'python3 可用' || fail '缺少 python3'
command -v node >/dev/null 2>&1 && pass 'node 可用' || fail '缺少 node'
command -v npm >/dev/null 2>&1 && pass 'npm 可用' || fail '缺少 npm'

if [[ -f scripts/validate_contracts.py ]]; then
  if python3 scripts/validate_contracts.py; then pass 'V1 合同校验'; else fail 'V1 合同校验失败'; fi
fi

if [[ -d backend && -f backend/requirements.txt ]]; then
  if python3 -m pytest -q backend/tests; then pass '后端测试'; else fail '后端测试失败'; fi
else
  skip '后端入口尚未合并，跳过后端测试'
fi

if [[ -d frontend && -f frontend/package.json ]]; then
  if (cd frontend && npm ci --ignore-scripts && npm run build); then pass '前端类型检查与构建'; else fail '前端构建失败'; fi
else
  skip '前端控制台尚未合并，跳过前端构建'
fi

for required in delivery/README.md delivery/demo-checklist.md CONTRIBUTING.md .github/merge-policy.md; do
  [[ -f "$required" ]] && pass "交付文档：$required" || fail "缺少交付文档：$required"
done

if (( failures > 0 )); then
  printf '\n交付检查失败：%d 项。\n' "$failures" >&2
  exit 1
fi
printf '\n交付检查通过（允许存在明确标记的 SKIP）。\n'
