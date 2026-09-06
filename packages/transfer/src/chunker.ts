// 把任意来源切成定长帧（末帧可短）。替代 bulk-client 的 iterateBulkFrames 与
// gateway rtc/bulk.ts 里 pumpDownload 的手写缓冲。

import { concatBytes } from './bytes';

/** DataChannel bulk 帧：两个方向统一 16 KiB（与 `FRAGMENT_SEND_MESSAGE_BYTES` 同源）。 */
export const BULK_FRAME_BYTES = 16 * 1024;
/** 兼容老版本对端仍会发 64 KiB 整帧，接收侧上限保持不变。 */
export const BULK_MAX_FRAME_BYTES = 64 * 1024;

export type FrameSource = Blob | ReadableStream<Uint8Array>;

export interface IterateFramesOptions {
  /** 流式来源时回调一次，交出取消句柄（消费方需要在外部中断读取时用）。 */
  onCancel?: (cancel: () => void) => void;
}

function isBlobLike(source: FrameSource): source is Blob {
  const candidate = source as Partial<Blob>;
  return typeof candidate.slice === 'function' && typeof candidate.arrayBuffer === 'function';
}

async function* iterateBlobFrames(source: Blob, frameSize: number): AsyncGenerator<Uint8Array> {
  const total = source.size;
  for (let offset = 0; offset < total; offset += frameSize) {
    const slice = source.slice(offset, Math.min(offset + frameSize, total));
    yield new Uint8Array(await slice.arrayBuffer());
  }
}

async function* iterateStreamFrames(
  source: ReadableStream<Uint8Array>,
  frameSize: number,
  opts: IterateFramesOptions
): AsyncGenerator<Uint8Array> {
  const reader = source.getReader();
  opts.onCancel?.(() => {
    void reader.cancel().catch(() => {});
  });
  let pending: Uint8Array = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      pending = concatBytes(pending, value);
      while (pending.byteLength >= frameSize) {
        yield pending.subarray(0, frameSize).slice();
        pending = pending.subarray(frameSize).slice();
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  if (pending.byteLength > 0) yield pending;
}

export function iterateFrames(
  source: FrameSource,
  frameSize: number,
  opts: IterateFramesOptions = {}
): AsyncGenerator<Uint8Array> {
  if (frameSize <= 0) throw new RangeError('frameSize must be positive');
  return isBlobLike(source)
    ? iterateBlobFrames(source, frameSize)
    : iterateStreamFrames(source, frameSize, opts);
}
