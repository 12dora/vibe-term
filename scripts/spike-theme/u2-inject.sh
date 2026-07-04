#!/bin/bash
# U2/U3/U4：指定 tmux 二进制 + 独立 socket，pane 里跑真 TUI，注入序列，采集屏幕/输出
# 用法: u2-inject.sh <tmux-bin> <socket> <out-dir> <pane-cmd...>
# 环境: INJECT_STEPS="delay_s:hex delay_s:hex ..."（相对 TUI 启动，顺序执行）
#       SETTLE=启动等待秒数（默认 5）
set -eu
TMUX_BIN=$1; SOCK=$2; OUT=$3; shift 3
SETTLE=${SETTLE:-5}
STEPS=${INJECT_STEPS:-}

[ -n "$SOCK" ] || { echo "FATAL: empty socket"; exit 1; }
case "$SOCK" in tmex*) echo "FATAL: socket 名不允许以 tmex 开头（防呆）"; exit 1;; esac

T() { "$TMUX_BIN" -L "$SOCK" -f /dev/null "$@"; }

mkdir -p "$OUT"
T kill-server 2>/dev/null || true
sleep 0.3
T new-session -d -s u -x 120 -y 35 "$*"
sleep "$SETTLE"
PANE=$(T display -p -t u '#{pane_id}')
T capture-pane -e -p -t "$PANE" > "$OUT/screen-0-before.txt"

i=0
for step in $STEPS; do
  i=$((i + 1))
  delay=${step%%:*}
  hex=${step#*:}
  sleep "$delay"
  args=""
  h=$hex
  while [ -n "$h" ]; do args="$args ${h:0:2}"; h=${h:2}; done
  # shellcheck disable=SC2086
  T send-keys -H -t "$PANE" $args
  sleep 1.2
  T capture-pane -e -p -t "$PANE" > "$OUT/screen-$i-after.txt"
  echo "$step" >> "$OUT/steps.txt"
done

T kill-server 2>/dev/null || true
echo "[done] $OUT"
