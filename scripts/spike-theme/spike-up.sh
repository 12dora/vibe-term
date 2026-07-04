#!/bin/bash
# 幂等起 6 个 tmux 版本矩阵容器并安装依赖（Apple container CLI）
set -u

MATRIX=(
  "tmex-spike-u2204:ubuntu:22.04:apt"
  "tmex-spike-d12:debian:12:apt"
  "tmex-spike-u2404:ubuntu:24.04:apt"
  "tmex-spike-d13:debian:13:apt"
  "tmex-spike-a324:alpine:3.24:apk"
  "tmex-spike-edge:alpine:edge:apk"
)

for entry in "${MATRIX[@]}"; do
  name=${entry%%:*}
  rest=${entry#*:}
  pkg=${rest##*:}
  image=${rest%:*}

  if container list --all 2>/dev/null | grep -q "^${name} "; then
    state=$(container list --all | awk -v n="$name" '$1==n {print $5}')
    if [ "$state" != "running" ]; then
      echo "[$name] 已存在但未运行，启动..."
      container start "$name"
    else
      echo "[$name] 已在运行"
    fi
  else
    echo "[$name] 创建 ${image} ..."
    container run -d --name "$name" "$image" sleep infinity
  fi

  if container exec "$name" sh -c 'command -v tmux >/dev/null && command -v python3 >/dev/null && command -v bash >/dev/null && command -v zsh >/dev/null'; then
    echo "[$name] 依赖已就绪: $(container exec "$name" tmux -V)"
    continue
  fi

  echo "[$name] 安装依赖..."
  if [ "$pkg" = "apt" ]; then
    container exec "$name" sh -c 'apt-get update -qq >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux python3 zsh bash >/dev/null 2>&1'
  else
    container exec "$name" sh -c 'apk add --no-cache tmux python3 zsh bash coreutils procps >/dev/null 2>&1'
  fi
  echo "[$name] $(container exec "$name" tmux -V)"
done

echo "=== 矩阵就绪 ==="
for entry in "${MATRIX[@]}"; do
  name=${entry%%:*}
  printf '%-18s %s\n' "$name" "$(container exec "$name" tmux -V 2>/dev/null || echo 'ERROR')"
done
