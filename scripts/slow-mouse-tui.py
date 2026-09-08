#!/usr/bin/env python3
"""Deterministic stand-in for Claude Code's scroll behaviour.

- enables SGR mouse reporting (1000/1002/1003/1006)
- every read() chunk that is exactly ONE SGR mouse sequence is applied; chunks
  containing more than one sequence (or anything else except 'q') are dropped —
  this mirrors Claude Code 2.1.263, verified with tmux send-keys -H experiments
- wheel up/down (button 64/65) moves a virtual offset by one line
- each applied event costs RENDER_MS of busy work and produces a full-screen redraw
  inside a DEC 2026 synchronized block; line 1 shows OFFSET=<n> APPLIED=<n> DROPPED=<n>

usage: slow-tui.py [render_ms]
"""
import os
import re
import select
import sys
import termios
import time
import tty

RENDER_MS = float(sys.argv[1]) if len(sys.argv) > 1 else 30.0
SEQ = re.compile(rb'\x1b\[<(\d+);(\d+);(\d+)([Mm])')
fd = sys.stdin.fileno()
old = termios.tcgetattr(fd)
tty.setraw(fd)
out = sys.stdout.buffer


def size():
    try:
        s = os.get_terminal_size()
        return s.columns, s.lines
    except OSError:
        return 80, 24


offset = 0
applied = 0
dropped = 0
frames = 0


def render():
    global frames
    frames += 1
    cols, rows = size()
    buf = [b'\x1b[?2026h\x1b[H']
    buf.append(f'OFFSET={offset} APPLIED={applied} DROPPED={dropped} FRAMES={frames}'.encode().ljust(cols)[:cols])
    for r in range(1, rows):
        n = offset + r
        line = f'\x1b[3{n % 7 + 1}m{n:06d}\x1b[0m line {n} ' + ('x' * ((n * 7) % 60))
        buf.append(b'\r\n' + line.encode()[: cols + 12].ljust(cols))
    buf.append(b'\x1b[?2026l')
    out.write(b''.join(buf))
    out.flush()
    end = time.perf_counter() + RENDER_MS / 1000.0
    while time.perf_counter() < end:
        pass


try:
    out.write(b'\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h')
    render()
    while True:
        r, _, _ = select.select([fd], [], [], 1.0)
        if not r:
            continue
        chunk = os.read(fd, 65536)
        if not chunk:
            break
        if b'q' in chunk and not SEQ.search(chunk):
            break
        events = SEQ.findall(chunk)
        if len(events) != 1 or SEQ.sub(b'', chunk) != b'':
            dropped += max(1, len(events))
            continue
        btn = int(events[0][0]) & ~0x1c
        if btn == 64:
            offset += 1
        elif btn == 65:
            offset = max(0, offset - 1)
        else:
            continue
        applied += 1
        render()
finally:
    out.write(b'\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1049l')
    out.flush()
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
