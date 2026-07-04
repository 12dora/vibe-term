#!/usr/bin/env python3
"""解析 pty-harness 日志：报告关键序列出现时间（相对启动 ms）与方向。
用法: analyze-tui.py <log> [<log>...]
"""
import re
import sys

TARGETS = {
    '?2031h': '1b5b3f3230333168',
    '?2031l': '1b5b3f323033316c',
    '?1004h': '1b5b3f3130303468',
    '?1004l': '1b5b3f313030346c',
    'OSC10?': '1b5d31303b3f',
    'OSC11?': '1b5d31313b3f',
    '?996n': '1b5b3f3939366e',
    'DECRQM2031': '1b5b3f323033312470',
    'DECRQM1004': '1b5b3f313030342470',
    'DCS-tmux': '1b50746d75783b',
    '?2004h': '1b5b3f3230303468',
    '?1049h': '1b5b3f3130343968',
    '?1049l': '1b5b3f3130343  96c'.replace(' ', ''),
    'RIS': '1b63',
    'DECSTR': '1b5b2170',
}


def analyze(path: str) -> None:
    streams = {'OUT': [], 'IN': []}
    events = []
    for line in open(path):
        m = re.match(r'^(\d+) (OUT|IN) ([0-9a-f]+)$', line)
        if m:
            streams[m.group(2)].append((int(m.group(1)), m.group(3)))
            continue
        m = re.match(r'^(\d+) EVT (.*)$', line)
        if m:
            events.append((int(m.group(1)), m.group(2)))
    t0 = None
    for t, e in events:
        if e.startswith('START'):
            t0 = t
            break
    if t0 is None and streams['OUT']:
        t0 = streams['OUT'][0][0]
    print(f'== {path}')
    for ts, e in events:
        print(f'  EVT +{ts - (t0 or ts)}ms {e[:100]}')
    for direction, chunks in streams.items():
        all_hex = ''.join(h for _, h in chunks)
        for name, needle in TARGETS.items():
            hits = []
            i = 0
            while (i := all_hex.find(needle, i)) >= 0:
                acc = 0
                ts = None
                for t, chunk in chunks:
                    if acc + len(chunk) > i:
                        ts = t
                        break
                    acc += len(chunk)
                hits.append(f'+{(ts or 0) - (t0 or 0)}ms')
                i += len(needle)
                if len(hits) >= 5:
                    break
            if hits:
                print(f'  {direction} {name:12} {" ".join(hits)}')


for p in sys.argv[1:]:
    analyze(p)
