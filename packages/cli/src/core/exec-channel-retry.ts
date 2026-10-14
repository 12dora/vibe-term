// exec 通道的重连策略：哪些关闭可以重试，以及退避 / 总时长预算。

import { NetworkError } from './errors';
import type { ConnEnd } from './exec-channel-conn';
import { errorFromClose } from './exec-channel-errors';
import { EXEC_CLOSE_UNSUPPORTED } from './exec-channel-socket';

/**
 * 会话尚未建立时的丢失不重试（重发 open 可能重复执行命令）；已建立则交给重连预算。
 * 已建立后的 4404 / 404 只是链路上的暂时故障（如 node 重启中），绝不能报「不支持」——
 * 调用方会据此回退旧路径并重跑命令。
 */
export function assertRetryable(
  entry: string,
  nodeId: string,
  end: Extract<ConnEnd, { kind: 'lost' }>,
  hasSession: boolean
): void {
  if (hasSession && end.code === EXEC_CLOSE_UNSUPPORTED) return;
  const terminal = errorFromClose(nodeId, end.code, end.reason);
  if (terminal) throw terminal;
  if (hasSession) return;
  const where = `${entry} (node ${nodeId})`;
  const detail = end.reason ? `: ${end.reason}` : '';
  throw new NetworkError(
    end.opened
      ? `connection to ${where} closed before the session started${detail}`
      : `cannot reach ${where}${detail}`
  );
}

/** 自首次丢失起计时，到 detachGraceMs 为止；每次成功 READY 后清零。 */
export class ReconnectBudget {
  private lossAt: number | null = null;
  private attempts = 0;

  constructor(
    private readonly graceMs: number,
    private readonly steps: readonly number[]
  ) {}

  get attempt(): number {
    return this.attempts;
  }

  reset(): void {
    this.lossAt = null;
    this.attempts = 0;
  }

  /** 下一次重试前要等多久；预算用尽则抛 NetworkError。 */
  nextDelay(): number {
    this.lossAt ??= Date.now();
    const remaining = this.lossAt + this.graceMs - Date.now();
    if (remaining <= 0) {
      throw new NetworkError(
        `connection lost; gave up reconnecting after ${Math.round(this.graceMs / 1000)}s`
      );
    }
    const step = this.steps[Math.min(this.attempts, this.steps.length - 1)] ?? 0;
    this.attempts += 1;
    return Math.min(step, remaining);
  }
}

/** 可被提前唤醒的睡眠（重连退避期间收到信号时用）。不 unref：退避期间要保持进程存活。 */
export class Sleeper {
  private wakeFn: (() => void) | null = null;

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wakeFn = () => {
        clearTimeout(timer);
        resolve();
      };
    }).finally(() => {
      this.wakeFn = null;
    });
  }

  wake(): void {
    this.wakeFn?.();
  }
}
