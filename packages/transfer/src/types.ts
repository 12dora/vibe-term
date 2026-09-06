// 传输引擎的通用类型。线上契约（任务快照 / NDJSON 事件）在 `@tmex/shared` 的
// `contracts/transfer.ts`，这里只放引擎内部三个消费者（浏览器上传下载、升级推包、
// 节点间传输）共用的字节层结构。

/** 半开区间 `[offset, offset + length)`。 */
export interface ByteRange {
  offset: number;
  length: number;
}

/** 一次进度采样：速率取滑动窗口，`etaSec` 在总量未知或速率为 0 时为 null。 */
export interface TransferProgressSample {
  transferredBytes: number;
  totalBytes: number;
  ratePerSec: number;
  etaSec: number | null;
}

/** 接收端已收状态；`ranges` 升序不重叠，append 模式下恒为至多一段。 */
export interface ReceivedState {
  receivedBytes: number;
  ranges: ByteRange[];
  complete: boolean;
}

export function rangeEnd(range: ByteRange): number {
  return range.offset + range.length;
}
