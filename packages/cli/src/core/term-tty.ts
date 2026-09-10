// attach 的本地 TTY 面：raw 模式、尺寸、SIGWINCH、退出时的复位。
//
// 远端程序可能开了备用屏、鼠标上报、bracketed paste，这些模式活在**本地**终端上，
// detach 时必须由我们关掉，否则用户回到 shell 会发现鼠标乱码、粘贴带 `~` 前后缀。

import { UsageError } from './errors';

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TtyStreams {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

/** detach 时发给本地终端的复位串：备用屏 / 鼠标 / bracketed paste / 光标 / SGR。 */
export const TERMINAL_RESET =
  '\u001b[?1049l\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?2004l\u001b[?25h\u001b[0m';

export const CLEAR_SCREEN = '\u001b[H\u001b[2J';

export function requireTty(streams: TtyStreams): void {
  if (streams.stdin.isTTY && streams.stdout.isTTY) return;
  throw new UsageError(
    'vibeterm term attach needs an interactive terminal on stdin and stdout',
    'for scripts and agents use: vibeterm term run | send | capture'
  );
}

export interface LocalTerminalOptions {
  /** 进程收到 SIGTERM / SIGHUP 时怎么退；测试注入用。 */
  exit?: (code: number) => void;
}

export class LocalTerminal {
  private dataHandler: ((chunk: Buffer) => void) | null = null;
  private resizeHandler: (() => void) | null = null;
  private exitHandler: (() => void) | null = null;
  private signalHandler: ((signal: NodeJS.Signals) => void) | null = null;
  private rawEnabled = false;
  private started = false;

  constructor(
    private readonly streams: TtyStreams,
    private readonly options: LocalTerminalOptions = {}
  ) {}

  size(): TerminalSize {
    return {
      cols: this.streams.stdout.columns || 80,
      rows: this.streams.stdout.rows || 24,
    };
  }

  /**
   * 进 raw 模式并开始收键盘字节。
   * 同时挂上 `exit` / SIGTERM / SIGHUP：这三条路径不复位就会把用户的 shell 留在 raw 模式里。
   */
  start(onData: (chunk: Buffer) => void, onResize: () => void): void {
    if (this.started) return;
    this.started = true;
    if (this.streams.stdin.isTTY) {
      this.streams.stdin.setRawMode(true);
      this.rawEnabled = true;
    }
    this.dataHandler = onData;
    this.resizeHandler = onResize;
    this.exitHandler = () => this.stop();
    this.signalHandler = (signal) => {
      this.stop();
      (this.options.exit ?? ((code: number) => process.exit(code)))(
        signal === 'SIGHUP' ? 129 : 143
      );
    };
    this.streams.stdin.on('data', onData);
    this.streams.stdin.resume();
    process.on('SIGWINCH', onResize);
    process.on('exit', this.exitHandler);
    process.on('SIGTERM', this.signalHandler);
    process.on('SIGHUP', this.signalHandler);
  }

  write(data: string | Uint8Array): void {
    this.streams.stdout.write(
      typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    );
  }

  /** 复位终端并停止收键盘字节；重复调用是空操作（复位串只写一次）。 */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.dataHandler) this.streams.stdin.off('data', this.dataHandler);
    if (this.resizeHandler) process.off('SIGWINCH', this.resizeHandler);
    if (this.exitHandler) process.off('exit', this.exitHandler);
    if (this.signalHandler) {
      process.off('SIGTERM', this.signalHandler);
      process.off('SIGHUP', this.signalHandler);
    }
    this.dataHandler = null;
    this.resizeHandler = null;
    this.exitHandler = null;
    this.signalHandler = null;
    if (this.rawEnabled && this.streams.stdin.isTTY) {
      this.streams.stdin.setRawMode(false);
      this.rawEnabled = false;
    }
    this.streams.stdin.pause();
    this.write(TERMINAL_RESET);
  }
}

/**
 * 把 stdin 的字节按流式 UTF-8 解成字符串：多字节字符被读取边界切开时不会变成替换字符。
 * TerminalInput 的载荷本身就是 UTF-8，非 UTF-8 的字节序列在浏览器端同样送不出去。
 */
export function createStdinDecoder(): (chunk: Uint8Array) => string {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return (chunk) => decoder.decode(chunk, { stream: true });
}
