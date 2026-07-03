#!/usr/bin/env python3
"""Task 6 鼠标坐标诊断 TUI：启用 SGR mouse mode 后把 stdin 原样写日志。

锚点行清晰可辨：让浏览器内 row 0/5/10 视觉位置与日志中 TUI 收到的 SGR row
直接对照。raw 模式读 stdin 避免行缓冲把 SGR 序列切碎。

启动：python3 scripts/issue45-mouse-tui.py <logfile>
退出：Ctrl+C 或外部 kill。
"""
import os
import sys
import termios
import tty

LOG_PATH = sys.argv[1] if len(sys.argv) > 1 else '/tmp/issue45-mouse-events.log'
DEBUG_OUT = '/tmp/issue45-tui-debug.log'

with open(LOG_PATH, 'w'):
    pass

enable_seq = '\x1b[?1000h\x1b[?1002h\x1b[?1006h'
clear_seq = '\x1b[2J\x1b[H'
sys.stdout.write(enable_seq)
sys.stdout.write(clear_seq)
for i in range(40):
    sys.stdout.write(f'row {i:2d}   ----\r\n')
sys.stdout.write('\x1b[H')
sys.stdout.flush()

with open(DEBUG_OUT, 'w') as f:
    f.write(enable_seq.encode('latin-1').hex())
    f.write('\n')
    f.write(f'enable_seq: {repr(enable_seq)}\n')
    f.write('cleared+rows written\n')

fd = sys.stdin.fileno()
old = termios.tcgetattr(fd)
try:
    tty.setraw(fd)
    while True:
        b = os.read(fd, 4096)
        if not b:
            break
        with open(LOG_PATH, 'ab') as f:
            f.write(b)
            f.flush()
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
    sys.stdout.write('\x1b[?1002l\x1b[?1006l\x1b[?1000l')
    sys.stdout.flush()
