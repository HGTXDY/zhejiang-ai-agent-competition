#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

command -v docker >/dev/null 2>&1 || { echo '缺少 docker，请安装 Docker Desktop。' >&2; exit 2; }
docker compose version >/dev/null 2>&1 || { echo '缺少 docker compose 插件。' >&2; exit 2; }

cleanup() { docker compose down --remove-orphans; }
trap cleanup EXIT

docker compose up --build -d
for attempt in {1..30}; do
  if curl --fail --silent http://127.0.0.1:8000/health >/dev/null && curl --fail --silent http://127.0.0.1:8080/ >/dev/null; then
    echo 'Compose 全栈冒烟通过：API 与前端均可访问。'
    exit 0
  fi
  sleep 2
done

echo 'Compose 全栈冒烟失败。' >&2
docker compose ps >&2
docker compose logs --tail=80 >&2
exit 1
