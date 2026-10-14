// exec 通道的信号 / 中断状态：谁算「转发」、谁算「杀会话」，以及杀会话的限时投递。

import type { ExecReady } from '@vibeterm/shared/exec-channel';
import { CliError } from './errors';
import type { ConnEnd } from './exec-channel-conn';
import { type ForwardedSignal, signalNumber } from './exec-channel-pty';
import type { ExecChannelResult } from './exec-channel-result';

export type SignalAction = 'forward' | 'kill';

export class InterruptState {
  /** 已决定结束本次运行的信号；null 表示还在正常运行。 */
  signal: ForwardedSignal | null = null;
  /** 链路当前不通，正在限时重连 / 等 READY 以投递 CLOSE{kill:true}。 */
  killPending = false;
  private presses = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly pty: boolean) {}

  /**
   * 非 PTY：首个信号转发给远端进程，再来一个就杀会话。
   * PTY：SIGINT 只是 raw 模式下的一个字节，外部发来的 SIGINT 同样先转发；
   * SIGTERM / SIGHUP 像 ssh 一样直接结束会话并还原终端。
   */
  press(signal: ForwardedSignal, hasSession: boolean): SignalAction {
    this.presses += 1;
    const terminating = this.pty && signal !== 'SIGINT';
    if (hasSession && this.presses === 1 && !terminating) return 'forward';
    this.signal = signal;
    return 'kill';
  }

  /** 这次连接结束后是否应当停止循环（而不是继续重连投递 CLOSE）。 */
  shouldStop(end: ConnEnd['kind'], hasSession: boolean): boolean {
    return this.signal !== null && (!this.killPending || end !== 'lost' || !hasSession);
  }

  arm(ms: number, onTimeout: () => void): void {
    this.killPending = true;
    this.timer = setTimeout(onTimeout, ms);
  }

  disarm(): void {
    this.killPending = false;
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

const FALLBACK_SIGNO = 2;

/** 被信号结束的运行结果；会话都没建立起来时没有设备信息，按 128+signo 抛出。 */
export function interruptedResult(
  signal: ForwardedSignal,
  ready: ExecReady | null,
  startedAt: number
): ExecChannelResult {
  if (!ready) throw new CliError('interrupted', 128 + (signalNumber(signal) ?? FALLBACK_SIGNO));
  return {
    exitCode: null,
    signal,
    reason: 'killed',
    durationMs: Date.now() - startedAt,
    device: ready.device,
  };
}
