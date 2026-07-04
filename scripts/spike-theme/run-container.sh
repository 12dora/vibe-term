#!/bin/bash
# 宿主侧：向指定容器推送脚本、执行 test-runner、拉回日志
# 用法: run-container.sh <container> <结果目录> [t1 t2 ...]
set -eu

C=$1
DEST=$2
shift 2
TESTS=${*:-t1 t2 t3 t4 t5 t6 t7 t8 t9 t10 t11}

HERE=$(cd "$(dirname "$0")" && pwd)

container exec -i "$C" sh -c 'cat > /opt/dump-tui.py' < "$HERE/dump-tui.py"
container exec -i "$C" sh -c 'cat > /opt/test-runner.sh && chmod +x /opt/test-runner.sh' < "$HERE/test-runner.sh"
container exec "$C" sh -c 'rm -rf /log && mkdir -p /log'
# shellcheck disable=SC2086
container exec "$C" bash /opt/test-runner.sh $TESTS
mkdir -p "$DEST"
container exec "$C" tar -C / -cf - log | tar -xf - -C "$DEST" --strip-components=1
echo "[done] $C -> $DEST"
