// 单段进度的统一构造：百分比、速率、字节明细与精确字节数都从同一个累计值算出。

import { ProgressTracker } from '@vibeterm/transfer';
import { formatBytesPair, formatRate } from './format';
import type { OnLeg } from './transfer-types';

export interface LegReporter {
  /** 累计字节；只在整段完成时才会给出 100%。 */
  report(bytes: number): void;
  /** 整段完成：100% 且 bytes = totalBytes。 */
  finish(): void;
}

export function createLegReporter(
  leg: 1 | 2,
  totalBytes: number,
  onLeg: OnLeg | undefined,
  detail: (bytes: number, total: number) => string = formatBytesPair
): LegReporter {
  const tracker = new ProgressTracker({ totalBytes });
  const emit = (bytes: number, pct: number, withRate: boolean): void => {
    if (!onLeg) return;
    const rate = withRate ? tracker.ratePerSec() : 0;
    onLeg(leg, {
      pct,
      rate: rate > 0 ? formatRate(rate) : undefined,
      detail: detail(bytes, totalBytes),
      bytes,
      totalBytes,
    });
  };
  return {
    report(bytes) {
      tracker.set(bytes);
      const done = totalBytes > 0 ? Math.floor((bytes / totalBytes) * 100) : 0;
      emit(bytes, Math.max(0, Math.min(99, done)), true);
    },
    finish() {
      emit(totalBytes, 100, false);
    },
  };
}
