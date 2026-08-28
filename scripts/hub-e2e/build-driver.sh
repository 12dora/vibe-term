#!/usr/bin/env bash
# 把 driver/*.ts 打成单文件 JS（--target bun），供没有 node_modules 的远程主机使用。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
rm -rf "${ROOT}/driver-dist"
bun build "${ROOT}"/driver/login.ts "${ROOT}"/driver/nodes.ts "${ROOT}"/driver/terminal.ts "${ROOT}"/driver/files.ts \
  --target bun --outdir "${ROOT}/driver-dist"
