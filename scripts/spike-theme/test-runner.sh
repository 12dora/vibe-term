#!/bin/bash
# 容器内执行：跑 T1-T11 全部采集，日志落 /log/<test-id>/
# 断言不在此处做——宿主侧 spike-assert.ts 统一解读。
set -u

SOCK=${SPIKE_SOCK:-spike}
TMUX_BIN=${SPIKE_TMUX_BIN:-tmux}
TMUX="$TMUX_BIN -L $SOCK -f /dev/null"
LOG=${SPIKE_LOG:-/log}
PY=${SPIKE_PY:-/opt/dump-tui.py}
RUNTMP=${SPIKE_TMP:-/tmp}
CM_IN=$RUNTMP/cm.in
TUI_FIFO=$RUNTMP/tui.cmd

[ -n "$SOCK" ] || { echo "FATAL: empty socket" >&2; exit 1; }
TMUX_VER=$($TMUX -V 2>/dev/null || tmux -V)
mkdir -p "$LOG"
echo "$TMUX_VER" > "$LOG/tmux-version.txt"

PANE=""
CUR=""

cleanup_env() {
  $TMUX kill-server 2>/dev/null
  pkill -f "\-L $SOCK -C attach" 2>/dev/null
  [ -f "$RUNTMP/tail.pid" ] && kill "$(cat "$RUNTMP/tail.pid")" 2>/dev/null
  rm -f "$CM_IN" "$TUI_FIFO" "$RUNTMP/tail.pid"
  sleep 0.3
}

# new_env <test-id> [pane-command...]
new_env() {
  CUR=$1; shift
  cleanup_env
  rm -rf "$LOG/$CUR"; mkdir -p "$LOG/$CUR"
  local cmd=${*:-"python3 $PY --log $LOG/$CUR/tui.log --fifo $TUI_FIFO"}
  $TMUX new-session -d -s t -x 100 -y 30 "$cmd" || { echo "FATAL new-session $CUR" >&2; exit 1; }
  mkfifo "$CM_IN"
  tail -f /dev/null > "$CM_IN" &
  echo $! > "$RUNTMP/tail.pid"
  nohup sh -c "cat $CM_IN | $TMUX_BIN -L $SOCK -C attach -t t" >"$LOG/$CUR/cm.log" 2>&1 &
  sleep 0.6
  PANE=$($TMUX display -p -t t '#{pane_id}')
  echo "$PANE" > "$LOG/$CUR/pane-id.txt"
}

# fake TUI 向终端方向发 hex
emit() { echo "$1" > "$TUI_FIFO"; sleep 0.4; }

# 向 pane stdin 注入 hex 串
inject() {
  local hex=$1 args=""
  while [ -n "$hex" ]; do args="$args ${hex:0:2}"; hex=${hex:2}; done
  # shellcheck disable=SC2086
  $TMUX send-keys -H -t "$PANE" $args
  sleep 0.4
}

# 通过观察者 control client 发 tmux 命令
cm_cmd() { echo "$1" > "$CM_IN"; sleep 0.3; }

snap() { $TMUX capture-pane -p -t "$PANE" > "$LOG/$CUR/$1" 2>&1; }

note() { echo "$*" >> "$LOG/$CUR/notes.txt"; }

run_rec() { # run_rec <label> <tmux subcommand...>
  local label=$1; shift
  { echo "\$ tmux $*"; $TMUX "$@" 2>&1; echo "exit=$?"; } >> "$LOG/$CUR/cmd-$label.txt"
}

echo "=== $TMUX_VER ==="

########################################
# T1: mode 声明的 %output 可见性
########################################
t1() {
  local seqs=(
    "2031h:1b5b3f3230333168"
    "2031l:1b5b3f323033316c"
    "1004h:1b5b3f3130303468"
    "1004l:1b5b3f313030346c"
    "multi:1b5b3f313030343b3230333168"
    "2004h:1b5b3f3230303468"
    "1049h:1b5b3f3130343968"
  )
  for s in "${seqs[@]}"; do
    new_env "T1_${s%%:*}"
    emit "${s#*:}"
    sleep 0.3
  done
}

########################################
# T2: OSC 10/11 查询 + ?996n：透出 × 代答，window-style 设/不设
########################################
t2() {
  local queries=(
    "q10bel:1b5d31303b3f07"
    "q10st:1b5d31303b3f1b5c"
    "q11bel:1b5d31313b3f07"
    "q11st:1b5d31313b3f1b5c"
    "q996:1b5b3f3939366e"
  )
  for ws in 0 1; do
    for q in "${queries[@]}"; do
      new_env "T2_${q%%:*}_ws${ws}"
      if [ "$ws" = "1" ]; then
        run_rec setws set-option -w -t t window-style 'fg=#d0d0d0,bg=#262626'
        sleep 0.3
      fi
      emit "${q#*:}"
      sleep 1.2   # 给代答留时间
    done
  done
}

########################################
# T3: 注入 997 完整性
########################################
t3() {
  new_env "T3_997"
  inject "1b5b3f3939373b316e"
  new_env "T3_997light"
  inject "1b5b3f3939373b326e"
}

########################################
# T4: 注入 OSC 11 应答（ST/BEL）完整性与份数
########################################
t4() {
  # ESC]11;rgb:d0d0/d0d0/d0d0 + ST / BEL
  local body="1b5d31313b7267623a643064302f643064302f64306430"
  new_env "T4_st"
  inject "${body}1b5c"
  new_env "T4_bel"
  inject "${body}07"
}

########################################
# T5: focus 序列注入 × focus-events × pane 是否订阅 1004
########################################
t5() {
  for fe in off on; do
    for sub in 0 1; do
      new_env "T5_fe${fe}_sub${sub}"
      run_rec fe set-option -g focus-events "$fe"
      [ "$sub" = "1" ] && emit "1b5b3f3130303468"
      sleep 0.3
      inject "1b5b4f"
      inject "1b5b49"
      sleep 0.5
    done
  done
}

########################################
# T6: idle shell 污染签名（bash/zsh × 997/focus/OSC应答）
########################################
t6() {
  local payloads=(
    "997:1b5b3f3939373b326e"
    "focus:1b5b4f1b5b49"
    "osc11resp:1b5d31313b7267623a643064302f643064302f643064301b5c"
  )
  for sh_ in bash zsh; do
    local shcmd="bash --norc --noprofile"
    [ "$sh_" = "zsh" ] && shcmd="zsh -f"
    for p in "${payloads[@]}"; do
      new_env "T6_${sh_}_${p%%:*}" "$shcmd"
      sleep 1.0   # 等提示符
      snap before.txt
      inject "${p#*:}"
      sleep 0.8
      snap after.txt
      # 回车一次看回显残留进命令行的形态
      inject "0d"
      sleep 0.5
      snap after-enter.txt
    done
  done
}

########################################
# T7: 3.6+/3.7 原生 theme 行为（其他版本作对照跑）
########################################
t7() {
  # (a) 订阅 2031 后是否立即收 997
  new_env "T7_sub"
  emit "1b5b3f3230333168"
  sleep 1.5
  # (b) theme option 存在性
  run_rec show_theme show-options -s theme
  run_rec set_theme_dark set-option -s theme dark
  sleep 1.0   # 若 set 成功且触发下发，tui.log 应出现 997
  run_rec set_theme_light set-option -s theme light
  sleep 1.0
  # (c) window-style 变化是否触发原生 997（同一 env 继续，pane 已订阅）
  run_rec ws_dark set-option -w -t t window-style 'fg=#d0d0d0,bg=#262626'
  sleep 1.0
  run_rec ws_light set-option -w -t t window-style 'fg=#171717,bg=#e8e8e8'
  sleep 1.5
  # (e) 订阅状态 format 候选
  run_rec fmt display -p -t "$PANE" 'client_theme=[#{client_theme}] pane_theme=[#{pane_theme}] theme=[#{theme}] pane_modes=[#{pane_modes}] pane_theme_updates=[#{pane_theme_updates}]'
  # 996 应答（theme 已 set 后）
  emit "1b5b3f3939366e"
  sleep 1.0
}

########################################
# T8: DECRQM ?2031$p / ?1004$p
########################################
t8() {
  new_env "T8_2031"
  emit "1b5b3f323033312470"
  sleep 1.0
  new_env "T8_1004"
  emit "1b5b3f313030342470"
  sleep 1.0
  # 订阅后再查（应答值应变化）
  new_env "T8_2031_after_sub"
  emit "1b5b3f3230333168"
  sleep 0.3
  emit "1b5b3f323033312470"
  sleep 1.0
}

########################################
# T9: pane 用户选项持久化
########################################
t9() {
  new_env "T9"
  run_rec set set-option -p -t "$PANE" @tmex_2031 on
  run_rec show show-options -p -t "$PANE" -v @tmex_2031
  run_rec list list-panes -a -F '#{pane_id} [#{@tmex_2031}]'
  run_rec killpane kill-session -t t
  sleep 0.3
  $TMUX new-session -d -s t2 -x 80 -y 24 "sleep 300"
  PANE=$($TMUX display -p -t t2 '#{pane_id}')
  run_rec list_after list-panes -a -F '#{pane_id} [#{@tmex_2031}]'
}

########################################
# T10: %pause 期间输出是否丢失（SIGSTOP 观察者制造背压）
########################################
t10() {
  new_env "T10"
  cm_cmd "refresh-client -f pause-after=1"
  sleep 0.3
  local obs_pid
  obs_pid=$(pgrep -f "\-L $SOCK -C attach" | head -1)
  kill -STOP "$obs_pid" 2>/dev/null
  # 制造大量输出 + 关键标记
  $TMUX send-keys -t "$PANE" "" 2>/dev/null   # noop 保活
  emit "$(printf 'AA%.0s' $(seq 1 50) | od -An -tx1 | tr -d ' \n')" 2>/dev/null || true
  # pane 大量输出：让 fake tui emit 4KB 填充
  local filler
  filler=$(printf '58%.0s' $(seq 1 2000))   # 2000 个 'X'
  emit "$filler"
  emit "1b5b3f3230333168"   # 关键标记：pause 期间的订阅
  sleep 3
  kill -CONT "$obs_pid" 2>/dev/null
  sleep 1.5
  note "pause test: marker=?2031h emitted during STOP"
}

########################################
# T11: DCS passthrough 包裹 × allow-passthrough
########################################
t11() {
  for ap in off on; do
    new_env "T11_ap${ap}"
    run_rec ap set-option -w -t t allow-passthrough "$ap"
    sleep 0.3
    # ESC Ptmux; ESC ESC [?2031h ESC \
    emit "1b50746d75783b1b1b5b3f32303331681b5c"
    sleep 0.8
  done
}

for t in "$@"; do
  echo "--- running $t ---"
  "$t"
done
cleanup_env
echo "=== done ==="
