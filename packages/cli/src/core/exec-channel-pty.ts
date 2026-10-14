// exec 通道的本地终端侧：raw 模式、窗口尺寸跟随、进程信号转发。

import { constants } from 'node:os';
import type { ReadStream, WriteStream } from 'node:tty';
import type { ExecSignal } from '@vibeterm/shared/exec-channel';

export type ForwardedSignal = Extract<ExecSignal, 'SIGINT' | 'SIGTERM' | 'SIGHUP'>;
export const FORWARDED_SIGNALS: readonly ForwardedSignal[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** 开 raw 模式并返回还原函数；还原时异常（fd 已关闭）忽略。 */
export function enterRawMode(input: ReadStream): () => void {
  const wasRaw = input.isRaw === true;
  input.setRawMode(true);
  return () => {
    try {
      input.setRawMode(wasRaw);
    } catch {
      // tty 已被关闭：没有可还原的状态
    }
  };
}

export function ttySize(output: WriteStream, fallback: { cols: number; rows: number }) {
  return { cols: output.columns || fallback.cols, rows: output.rows || fallback.rows };
}

export function watchResize(output: WriteStream, onResize: () => void): () => void {
  output.on('resize', onResize);
  return () => output.removeListener('resize', onResize);
}

/** 安装 SIGINT/SIGTERM/SIGHUP 处理器，返回卸载函数。 */
export function installSignalHandlers(onSignal: (signal: ForwardedSignal) => void): () => void {
  const handlers = FORWARDED_SIGNALS.map((signal) => {
    const handler = () => onSignal(signal);
    process.on(signal, handler);
    return { signal, handler };
  });
  return () => {
    for (const { signal, handler } of handlers) process.removeListener(signal, handler);
  };
}

export function signalNumber(name: string): number | null {
  const value = (constants.signals as Record<string, number | undefined>)[name];
  return typeof value === 'number' ? value : null;
}
