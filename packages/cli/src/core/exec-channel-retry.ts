// exec 通道的重连策略：哪些关闭可以重试，以及退避 / 总时长预算。

import { NetworkError } from './errors';
import type { ConnEnd } from './exec-channel-conn';
import { errorFromClose } from './exec-channel-errors';

/** 会话尚未建立时的丢失不重试（重发 open 可能重复执行命令）；已建立则交给重连预算。 */
export function assertRetryable(
  nodeId: string,
  end: Extract<ConnEnd, { kind: 'lost' }>,
  hasSession: boolean
): void {
  const terminal = errorFromClose(nodeId, end.code, end.reason);
  if (terminal) throw terminal;
  if (hasSession) return;
  const detail = end.reason ? `: ${end.reason}` : ` (close ${end.code})`;
  throw new NetworkError(
    end.opened
      ? `exec channel to node ${nodeId} closed before the session started${detail}`
      : `cannot reach exec channel of node ${nodeId}${detail}`
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
