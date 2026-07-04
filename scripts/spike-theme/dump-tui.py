#!/usr/bin/env python3
"""受控 fake TUI：占住 pane，把 stdin 收到的字节以 hex+时间戳落盘，可按需向终端发送序列。

用法:
  python3 dump-tui.py --log /tmp/tui.log [--emit <hex>] [--fifo /tmp/tui.cmd]

--emit: 启动后立即向终端(stdout)写出的字节（hex 串，如 1b5b3f3230333168）
--fifo: 命令管道；向其写入一行 hex 即向终端发送对应字节；写入 "quit" 退出
日志格式: 每次 read 一行 "<epoch_ms> <hex>"
"""
import argparse
import os
import sys
import termios
import threading
import time
import tty


def now_ms() -> int:
    return int(time.time() * 1000)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--log', required=True)
    ap.add_argument('--emit', default='')
    ap.add_argument('--fifo', default='')
    args = ap.parse_args()

    log = open(args.log, 'a', buffering=1)
    log.write(f'{now_ms()} START\n')

    stdin_fd = sys.stdin.fileno()
    old_attrs = None
    if os.isatty(stdin_fd):
        old_attrs = termios.tcgetattr(stdin_fd)
        tty.setraw(stdin_fd)

    out_fd = sys.stdout.fileno()

    def emit(hex_str: str) -> None:
        data = bytes.fromhex(hex_str.strip())
        os.write(out_fd, data)
        log.write(f'{now_ms()} EMIT {hex_str.strip().lower()}\n')

    if args.emit:
        emit(args.emit)

    stop = threading.Event()

    if args.fifo:
        if not os.path.exists(args.fifo):
            os.mkfifo(args.fifo)

        def fifo_loop() -> None:
            while not stop.is_set():
                try:
                    with open(args.fifo, 'r') as f:
                        for line in f:
                            line = line.strip()
                            if not line:
                                continue
                            if line == 'quit':
                                stop.set()
                                return
                            try:
                                emit(line)
                            except ValueError:
                                log.write(f'{now_ms()} BADCMD {line}\n')
                except OSError:
                    time.sleep(0.05)

        threading.Thread(target=fifo_loop, daemon=True).start()

    try:
        while not stop.is_set():
            data = os.read(stdin_fd, 4096)
            if not data:
                break
            log.write(f'{now_ms()} {data.hex()}\n')
    except OSError:
        pass
    finally:
        if old_attrs is not None:
            termios.tcsetattr(stdin_fd, termios.TCSADRAIN, old_attrs)
        log.write(f'{now_ms()} EXIT\n')
        log.close()


if __name__ == '__main__':
    main()
