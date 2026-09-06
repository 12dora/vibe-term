// 落盘文件的区间读：全仓唯一的「从磁盘取字节」入口。
// 泛化自 `apps/gateway/src/system/remote-upgrade-io.ts` 的 `fileReadableStream`，
// 并取代 `api/file-http.ts` 里不支持偏移的 `Bun.file().stream()`。

import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileSizeOrZero } from './sink-state';

const HASH_CHUNK_BYTES = 1024 * 1024;

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

/**
 * `[start, end)` 半开区间；`end` 省略表示读到文件尾。
 * 文件不存在时抛出（与旧的 `fileReadableStream` 一致，调用方按失败处理）。
 */
export function openRange(path: string, start = 0, end?: number): ReadableStream<Uint8Array> {
  const size = statSync(path).size;
  const from = Math.max(0, Math.trunc(start));
  const to = end === undefined ? size : Math.min(size, Math.max(from, Math.trunc(end)));
  if (size === 0 || from >= size || to <= from) return emptyStream();
  const stream =
    from === 0 && to === size
      ? createReadStream(path)
      : createReadStream(path, { start: from, end: to - 1 });
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

/** 流式算前缀摘要：内存占用与文件大小无关。返回是否读满了 `length` 字节。 */
export async function hashFilePrefix(
  path: string,
  length: number,
  hash: ReturnType<typeof createHash>
): Promise<boolean> {
  if (length <= 0) return true;
  try {
    const stream = createReadStream(path, {
      start: 0,
      end: length - 1,
      highWaterMark: HASH_CHUNK_BYTES,
    });
    let read = 0;
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      read += buf.byteLength;
      hash.update(buf);
    }
    return read === length;
  } catch {
    return false;
  }
}

/** 整文件 sha256（并行写入后的最终校验用）。读不到返回 null。 */
export async function sha256File(path: string): Promise<string | null> {
  const hash = createHash('sha256');
  const size = fileSizeOrZero(path);
  if (size === 0) return hash.digest('hex');
  return (await hashFilePrefix(path, size, hash)) ? hash.digest('hex') : null;
}
