#!/bin/bash
# 总驱动：起全部容器 + 逐容器全量跑 T1-T11 + 拉回日志
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
DEST=${1:?用法: run-all.sh <结果根目录>}

bash "$HERE/spike-up.sh"

for c in tmex-spike-u2204 tmex-spike-d12 tmex-spike-u2404 tmex-spike-d13 tmex-spike-a324 tmex-spike-edge; do
  tag=${c#tmex-spike-}
  echo "===== $c ====="
  bash "$HERE/run-container.sh" "$c" "$DEST/$tag"
done
echo "ALL DONE"
