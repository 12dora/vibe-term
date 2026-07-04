#!/usr/bin/env python3
"""PTY 直连采集 harness：跑真 TUI，双向字节流带时间戳落盘，可按剧本注入。

用法:
  pty-harness.py --log out.log [--term xterm-256color] [--cols 120] [--rows 40] \
    [--stimuli "500:1b5d31313b7267623a303030302f303030302f303030301b5c,3000:03"] \
    [--duration 10] -- <cmd> [args...]

stimuli 格式: "delay_ms:hex[,delay_ms:hex...]"；hex 也可为 SIG:CONT / SIG:TERM 等信号指令。
日志格式: "<epoch_ms> OUT|IN|EVT <hex|text>"，OUT=TUI→终端，IN=注入→TUI。
"""
import argparse
import fcntl
import os
import pty
import signal
import struct
import sys
import termios
import threading
import time


def now_ms() -> int:
    return int(time.time() * 1000)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--log', required=True)
    ap.add_argument('--term', default='xterm-256color')
    ap.add_argument('--cols', type=int, default=120)
    ap.add_argument('--rows', type=int, default=40)
    ap.add_argument('--stimuli', default='')
    ap.add_argument('--duration', type=float, default=10.0)
    ap.add_argument('--env', action='append', default=[], help='额外环境变量 KEY=VAL，可重复')
    ap.add_argument('cmd', nargs=argparse.REMAINDER)
    args = ap.parse_args()

    cmd = args.cmd
    if cmd and cmd[0] == '--':
        cmd = cmd[1:]
    if not cmd:
        print('missing command', file=sys.stderr)
        sys.exit(1)

    log = open(args.log, 'a', buffering=1)
    log.write(f'{now_ms()} EVT START cmd={cmd!r} term={args.term}\n')

    pid, master = pty.fork()
    if pid == 0:
        os.environ['TERM'] = args.term
        os.environ.pop('TMUX', None)
        os.environ.pop('TMUX_PANE', None)
        for kv in args.env:
            k, _, v = kv.partition('=')
            os.environ[k] = v
        try:
            os.execvp(cmd[0], cmd)
        except OSError as e:
            print(f'exec failed: {e}', file=sys.stderr)
            os._exit(127)

    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', args.rows, args.cols, 0, 0))

    stop = threading.Event()

    def reader() -> None:
        while not stop.is_set():
            try:
                data = os.read(master, 8192)
            except OSError:
                break
            if not data:
                break
            log.write(f'{now_ms()} OUT {data.hex()}\n')
        stop.set()

    threading.Thread(target=reader, daemon=True).start()

    def stimuli_loop() -> None:
        if not args.stimuli:
            return
        t0 = time.time()
        items = []
        for part in args.stimuli.split(','):
            delay_s, payload = part.split(':', 1)
            items.append((int(delay_s) / 1000.0, payload))
        items.sort(key=lambda x: x[0])
        for delay, payload in items:
            wait = t0 + delay - time.time()
            if wait > 0:
                if stop.wait(wait):
                    return
            if payload.startswith('SIG'):
                signame = payload.split(':', 1)[1] if ':' in payload else payload[3:]
                signum = getattr(signal, f'SIG{signame}')
                os.kill(pid, signum)
                log.write(f'{now_ms()} EVT SIG{signame}\n')
            else:
                data = bytes.fromhex(payload)
                os.write(master, data)
                log.write(f'{now_ms()} IN {payload.lower()}\n')

    threading.Thread(target=stimuli_loop, daemon=True).start()

    deadline = time.time() + args.duration
    status = None
    while time.time() < deadline and not stop.is_set():
        wpid, wstatus = os.waitpid(pid, os.WNOHANG)
        if wpid == pid:
            status = wstatus
            log.write(f'{now_ms()} EVT CHILD-EXIT status={wstatus}\n')
            break
        time.sleep(0.05)

    if status is None:
        os.kill(pid, signal.SIGTERM)
        time.sleep(0.5)
        try:
            wpid, wstatus = os.waitpid(pid, os.WNOHANG)
            if wpid != pid:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
        except OSError:
            pass
        log.write(f'{now_ms()} EVT TIMEOUT-KILL\n')

    time.sleep(0.3)
    stop.set()
    log.write(f'{now_ms()} EVT END\n')
    log.close()


if __name__ == '__main__':
    main()
