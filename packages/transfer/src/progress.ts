// 速率 / ETA / 节流：全仓唯一实现。
// 速率取滑动窗口而不是「总字节 ÷ 总耗时」——后者在链路突然变慢时要几十秒才反应过来。

import type { TransferProgressSample } from './types';

const DEFAULT_WINDOW_MS = 3_000;

export interface ProgressTrackerOptions {
  /** 总字节数；未知时传 0，`etaSec` 恒为 null。 */
  totalBytes: number;
  windowMs?: number;
  now?: () => number;
}

type Sample = { at: number; bytes: number };

/** 累计字节 → 速率 / ETA。调用方每次拿到新的累计值就 `set()`。 */
export class ProgressTracker {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly samples: Sample[] = [];
  private transferred = 0;
  totalBytes: number;

  constructor(opts: ProgressTrackerOptions) {
    this.totalBytes = Math.max(0, opts.totalBytes);
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = opts.now ?? Date.now;
    this.samples.push({ at: this.now(), bytes: 0 });
  }

  set(transferredBytes: number): void {
    this.transferred = Math.max(0, transferredBytes);
    const at = this.now();
    this.samples.push({ at, bytes: this.transferred });
    const cutoff = at - this.windowMs;
    // 保留窗口左边界外的最后一个采样，否则窗口刚满时算不出速率。
    let drop = 0;
    while (drop + 1 < this.samples.length && (this.samples[drop + 1]?.at ?? 0) < cutoff) drop += 1;
    if (drop > 0) this.samples.splice(0, drop);
  }

  add(deltaBytes: number): void {
    this.set(this.transferred + deltaBytes);
  }

  get transferredBytes(): number {
    return this.transferred;
  }

  ratePerSec(): number {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last) return 0;
    const elapsed = (last.at - first.at) / 1000;
    if (elapsed <= 0) return 0;
    const delta = last.bytes - first.bytes;
    return delta > 0 ? delta / elapsed : 0;
  }

  etaSec(): number | null {
    if (this.totalBytes <= 0) return null;
    const remaining = this.totalBytes - this.transferred;
    if (remaining <= 0) return 0;
    const rate = this.ratePerSec();
    if (rate <= 0) return null;
    return remaining / rate;
  }

  snapshot(): TransferProgressSample {
    return {
      transferredBytes: this.transferred,
      totalBytes: this.totalBytes,
      ratePerSec: this.ratePerSec(),
      etaSec: this.etaSec(),
    };
  }
}

export interface ThrottleOptions {
  /** 两次回调的最小间隔；默认 200 ms。 */
  intervalMs?: number;
  /** 增量达到该字节数即使没到间隔也回调；0 表示只看时间。 */
  minBytes?: number;
  now?: () => number;
}

export interface ThrottledProgress {
  (bytes: number): void;
  /** 强制发一次（收尾时用，保证最终值一定送达）。 */
  flush(): void;
}

/** 按时间 + 增量双阈值节流的进度回调。 */
export function throttleProgress(
  onProgress: (bytes: number) => void,
  opts: ThrottleOptions = {}
): ThrottledProgress {
  const intervalMs = opts.intervalMs ?? 200;
  const minBytes = opts.minBytes ?? 0;
  const now = opts.now ?? Date.now;
  let lastAt = Number.NEGATIVE_INFINITY;
  let lastBytes = 0;
  let pending: number | null = null;
  const emit: ThrottledProgress = ((bytes: number) => {
    pending = bytes;
    const at = now();
    if (at - lastAt < intervalMs && (minBytes <= 0 || bytes - lastBytes < minBytes)) return;
    lastAt = at;
    lastBytes = bytes;
    pending = null;
    onProgress(bytes);
  }) as ThrottledProgress;
  emit.flush = () => {
    if (pending === null) return;
    const bytes = pending;
    pending = null;
    lastAt = now();
    lastBytes = bytes;
    onProgress(bytes);
  };
  return emit;
}
