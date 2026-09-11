/** 应答侧记住的 offer epoch 的有效期：够覆盖一次拨号窗口内的在途信令即可。 */
export const RTC_OFFER_EPOCH_TTL_MS = 30_000;

/** offerer epoch 的时间基：每秒预留这么多个序号，同时保证秒数抬升一定压过进程内计数器。 */
export const RTC_EPOCH_PER_SECOND = 4096;

/**
 * offerer 的 epoch 以秒级时间戳为基数分配，保证**跨进程重启单调递增**：
 * 重启后新进程的基数至少比旧进程启动时高 uptime 秒，远大于旧进程用掉的序号，
 * 应答侧因此不会把重启后的新 offer 当成陈旧信令（也不会被重启前的迟到 offer supersede）。
 * 结果始终是安全整数（2100 年的基数也只有 1.7e13），对 2.1.x / 2.2.x 的 `isValidOptionalEpoch` 合法。
 */
export function rtcAttemptEpochBase(nowMs: number): number {
  return Math.max(0, Math.floor(nowMs / 1000)) * RTC_EPOCH_PER_SECOND;
}

type OfferEpochEntry = { epoch: number; at: number };

/**
 * 记住对端 offer 的最高 epoch，用来丢弃被取代的旧 attempt 留下的在途 SDP / candidate。
 * 只在短窗口内有效：对端进程重启后 epoch 计数从 0 重新开始，若永久记住旧高位，
 * 重启后的所有 offer 都会被当成陈旧信令拒收，该 peer 永远建不起 DC。
 */
export class OfferEpochMemory {
  private readonly entries = new Map<string, OfferEpochEntry>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(now: () => number, ttlMs: number = RTC_OFFER_EPOCH_TTL_MS) {
    this.now = now;
    this.ttlMs = ttlMs;
  }

  get(peerNodeId: string): number | undefined {
    const entry = this.entries.get(peerNodeId);
    if (!entry) return undefined;
    if (this.now() - entry.at > this.ttlMs) {
      this.entries.delete(peerNodeId);
      return undefined;
    }
    return entry.epoch;
  }

  /** 只有不低于已记住值的 epoch 才续期，避免重启后的低位 epoch 被反复刷新的旧值挡死。 */
  remember(peerNodeId: string, epoch: number | undefined): void {
    if (epoch === undefined) return;
    const prev = this.get(peerNodeId);
    if (prev !== undefined && epoch < prev) return;
    this.entries.set(peerNodeId, { epoch, at: this.now() });
  }

  clear(): void {
    this.entries.clear();
  }
}
