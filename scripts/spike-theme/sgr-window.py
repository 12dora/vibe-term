#!/usr/bin/env python3
"""按时间窗对比 pty-harness OUT 流的 SGR 颜色指纹。
用法: sgr-window.py <log> <split_ms相对START> [<split_ms2> ...]
输出每个窗口的 truecolor/256 色前景/背景 SGR 频次 top。
"""
import re
import sys
from collections import Counter

path = sys.argv[1]
splits = [int(x) for x in sys.argv[2:]]

chunks = []
t0 = None
for line in open(path):
    m = re.match(r'^(\d+) EVT START', line)
    if m and t0 is None:
        t0 = int(m.group(1))
    m = re.match(r'^(\d+) OUT ([0-9a-f]+)$', line)
    if m:
        chunks.append((int(m.group(1)), m.group(2)))
if t0 is None and chunks:
    t0 = chunks[0][0]

bounds = [0] + splits + [10 ** 9]
for w in range(len(bounds) - 1):
    lo, hi = bounds[w], bounds[w + 1]
    data = bytes.fromhex(''.join(h for t, h in chunks if lo <= t - t0 < hi))
    text = data.decode('utf8', 'replace')
    fg_tc = Counter(re.findall(r'\x1b\[[0-9;]*38;2;(\d+;\d+;\d+)[0-9;]*m', text))
    bg_tc = Counter(re.findall(r'\x1b\[[0-9;]*48;2;(\d+;\d+;\d+)[0-9;]*m', text))
    fg_256 = Counter(re.findall(r'\x1b\[[0-9;]*38;5;(\d+)[0-9;]*m', text))
    bg_256 = Counter(re.findall(r'\x1b\[[0-9;]*48;5;(\d+)[0-9;]*m', text))
    print(f'--- 窗口 {w}: [{lo}ms, {hi if hi < 10**9 else "∞"}ms) bytes={len(data)}')
    for name, c in [('fg-tc', fg_tc), ('bg-tc', bg_tc), ('fg256', fg_256), ('bg256', bg_256)]:
        if c:
            top = ' '.join(f'{k}×{v}' for k, v in c.most_common(4))
            print(f'    {name}: {top}')
