import type { FileHandle } from 'node:fs/promises';

export interface SinkWriteOptions {
  offset?: number;
  /**
   * 本次请求声明的字节数（content-length）。链路被 RST 时请求体往往「干净地结束」而不是报错，
   * 只有拿它对一下才分得清「传完了但内容坏了」与「传到一半断了」。
   */
  contentLength?: number;
  /** 本次写入允许接收的最大字节数；超出即判为越界（body 比声明的长）。 */
  maxWriteBytes?: number;
  /** 供调用方在外部顶掉这次写入（如同一目标的新请求到达）。 */
  registerCancel?: (cancel: () => void) => void;
  /** 会话级取消：一 abort 就停止读 body 并尽快关掉文件句柄。 */
  signal?: AbortSignal;
}

export type WriteTally = { bytes: number; aborted: boolean; failed: boolean; overflow: boolean };

/**
 * `write(2)` 允许短写。按返回的 `bytesWritten` 推进游标，直到整块写完；
 * 一次都没推进说明设备出问题了，当 IO 错误抛出，绝不能把没写进去的字节记成已收。
 */
async function writeAll(
  handle: FileHandle,
  chunk: Uint8Array,
  position: number | null,
  onWritten: (slice: Uint8Array) => void
): Promise<void> {
  let done = 0;
  while (done < chunk.byteLength) {
    const remaining = chunk.byteLength - done;
    const res =
      position === null
        ? await handle.write(chunk, done, remaining)
        : await handle.write(chunk, done, remaining, position + done);
    const written = Math.max(0, Math.min(res.bytesWritten ?? 0, remaining));
    if (written === 0) throw new Error('sink: zero-length write');
    onWritten(chunk.subarray(done, done + written));
    done += written;
  }
}

async function cancelBody(body: ReadableStream<Uint8Array>): Promise<void> {
  await body.cancel().catch(() => {});
}

type SinkFn = (chunk: Uint8Array, advance: (n: number) => void) => Promise<void>;

async function pumpBody(
  body: ReadableStream<Uint8Array>,
  opts: SinkWriteOptions,
  sink: SinkFn,
  limit: number
): Promise<WriteTally> {
  const reader = body.getReader();
  const tally: WriteTally = { bytes: 0, aborted: false, failed: false, overflow: false };
  const cancel = (): void => {
    void reader.cancel().catch(() => {});
  };
  const onAbort = (): void => {
    tally.aborted = true;
    cancel();
  };
  opts.registerCancel?.(onAbort);
  const signal = opts.signal;
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const advance = (n: number): void => {
    tally.bytes += n;
  };
  let drained = false;
  try {
    while (!tally.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        break;
      }
      if (!value?.byteLength) continue;
      if (tally.bytes + value.byteLength > limit) {
        tally.overflow = true;
        break;
      }
      await sink(value, advance);
    }
  } catch {
    tally.failed = true;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // 提前退出必须把 body 掐掉，否则发送端会一直往一个没人读的流里灌。
    // 唯一的例外是越界：中途 cancel 源流会让 413 回不到发送端（见 upgrade 的 413 语义），
    // 这时靠调用方立刻回响应来让对端自己停。
    if (!drained && !tally.overflow) cancel();
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
  return tally;
}

/**
 * 取消回调在打开文件之前就交给调用方：打开期间到达的取消不会丢，进入读循环后立即生效。
 */
function earlyCancel(opts: SinkWriteOptions): { opts: SinkWriteOptions } {
  if (!opts.registerCancel) return { opts };
  let pending = false;
  let live: (() => void) | null = null;
  opts.registerCancel(() => {
    if (live) live();
    else pending = true;
  });
  return {
    opts: {
      ...opts,
      registerCancel: (fn) => {
        live = fn;
        if (pending) fn();
      },
    },
  };
}

export async function pumpToHandle(input: {
  openHandle: () => Promise<FileHandle>;
  body: ReadableStream<Uint8Array>;
  opts: SinkWriteOptions;
  limit: number;
  /** 定位写的起点；`null` 表示按文件当前位置追加。 */
  position: number | null;
  onWritten?: (slice: Uint8Array) => void;
}): Promise<WriteTally> {
  const { openHandle, body, opts, limit, position, onWritten } = input;
  const early = earlyCancel(opts);
  if (opts.signal?.aborted) {
    await cancelBody(body);
    return { bytes: 0, aborted: true, failed: false, overflow: false };
  }
  let handle: FileHandle;
  try {
    handle = await openHandle();
  } catch {
    await cancelBody(body);
    return { bytes: 0, aborted: false, failed: true, overflow: false };
  }
  let cursor = position;
  const tally = await pumpBody(
    body,
    early.opts,
    async (chunk, advance) => {
      const base = cursor;
      await writeAll(handle, chunk, base, (slice) => {
        if (cursor !== null) cursor += slice.byteLength;
        onWritten?.(slice);
        advance(slice.byteLength);
      });
    },
    limit
  );
  try {
    await handle.close();
  } catch {
    tally.failed = true;
  }
  return tally;
}
