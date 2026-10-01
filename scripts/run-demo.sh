#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -d frontend || ! -f frontend/package.json ]]; then
  echo '当前提交不包含前端控制台，无法启动演示。'
  echo '请切换到包含 frontend/ 的最新 main 或功能分支。'
  exit 2
fi

if [[ ! -d frontend/node_modules ]]; then
  echo '首次运行：安装前端依赖。'
  (cd frontend && npm ci)
fi

echo 'CookFlow 前端演示即将启动： http://localhost:5173'
echo '前端默认使用配置的 Mock/HTTP 适配模式；演示时必须说明当前模式。'
exec npm --prefix frontend run dev -- --host 0.0.0.0
