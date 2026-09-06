// 转发请求体的三件小事：上行字节计数、进度节流，以及转发失败时把包装过的流收掉。
// 从 `forwarder.ts` 拆出来，纯函数、无状态，与转发状态机没有耦合。

/** 上行进度节流：至少 1 s 或 256 KiB 才回调一次，别把小块 IO 变成刷屏。 */
const PROGRESS_MIN_INTERVAL_MS = 1_000;
const PROGRESS_MIN_BYTES = 256 * 1024;

export function throttledProgress(onProgress: (bytes: number) => void): (bytes: number) => void {
  let lastAt = 0;
  let lastBytes = 0;
  return (bytes) => {
    const at = Date.now();
    if (at - lastAt < PROGRESS_MIN_INTERVAL_MS && bytes - lastBytes < PROGRESS_MIN_BYTES) return;
    lastAt = at;
    lastBytes = bytes;
    onProgress(bytes);
  };
}

export function countStreamBytes(
  body: ReadableStream<Uint8Array>,
  onBytes: (n: number) => void
): ReadableStream<Uint8Array> {
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        onBytes(chunk.byteLength);
        controller.enqueue(chunk);
      },
    })
  );
}

/**
 * 转发没成功时收掉包装过的请求体：传输层还没接手，没人再会去读它，
 * 不主动 cancel 的话源端的读取管道与文件句柄就一直挂着。
 */
export async function cancelForwardBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  try {
    if (body.locked) return;
    await body.cancel();
  } catch {
    // 已经关掉了
  }
}
