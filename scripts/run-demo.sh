#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -d frontend || ! -f frontend/package.json ]]; then
  echo '前端控制台尚未合并到当前提交，无法启动演示。'
  echo '请先合并 PR #25，或切换到 feat/14-execution-dashboard。'
  exit 2
fi

if [[ ! -d frontend/node_modules ]]; then
  echo '首次运行：安装前端依赖。'
  (cd frontend && npm ci)
fi

echo 'CookFlow 前端演示即将启动： http://localhost:5173'
echo '当前阶段使用 Mock API；真实后端接入前不得宣称为完整闭环。'
exec npm --prefix frontend run dev -- --host 0.0.0.0
