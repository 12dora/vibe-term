#!/bin/sh
# 模拟全屏 TUI：备用屏 + 同步输出 + 每行绝对定位，宽 205 列
fill=$(head -c 200 /dev/zero | tr '\0' '#')
printf '\033[?1049h\033[?2026h\033[H\033[2J'
printf '\033[1;1HREPLAY-LEFT-EDGE-1 %s' "$fill"
r=2
while [ $r -le 45 ]; do
  printf '\033[%d;1HR%02d-%s|END' "$r" "$r" "$fill"
  r=$((r+1))
done
printf '\033[46;1HREPLAY-LEFT-EDGE-2\033[?2026l'
