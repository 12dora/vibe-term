import type { FileErrorCode } from '@vibeterm/shared';
import { openRange } from '@vibeterm/transfer/node';
import { json } from './http';

const CODE_STATUS: Record<FileErrorCode, number> = {
  invalid: 400,
  outside_roots: 403,
  not_found: 404,
  not_a_directory: 400,
  is_directory: 400,
  too_large: 413,
  binary: 415,
  permission_denied: 403,
  device_not_found: 404,
  root_not_found: 404,
  root_disabled: 403,
  connection_failed: 502,
  auth_unsupported: 400,
  rsync_missing_local: 502,
  rsync_missing_remote: 502,
  timeout: 504,
  unknown: 500,
};

const NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-store',
};

export function codeError(code: FileErrorCode, detail?: string): Response {
  return json({ error: code, code, detail }, CODE_STATUS[code]);
}

export function parseNonNegativeSafeInt(raw: string | null): number | null {
  if (raw === null || raw === '' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

export function attachmentHeaders(
  name: string,
  mime: string | null,
  size: number
): Record<string, string> {
  const encoded = encodeURIComponent(name);
  const ascii = name.replace(/["\\\r\n]/g, '_');
  return {
    'Content-Type': mime ?? 'application/octet-stream',
    'Content-Length': String(size),
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
  };
}

/** 半开区间 `[start, end)`；`unsatisfiable` 对应 416。 */
export type ContentRange = { start: number; end: number };

/**
 * 只支持单段 `bytes=a-b` / `bytes=a-` / `bytes=-n`——下载续传用不到多段。
 * 没有 Range 头返回 null（整文件）。
 */
export function parseRangeHeader(
  header: string | null,
  size: number
): ContentRange | null | 'unsatisfiable' {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'unsatisfiable';
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return 'unsatisfiable';
  if (size <= 0) return 'unsatisfiable';
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size };
  }
  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start >= size) return 'unsatisfiable';
  const end = rawEnd ? Number(rawEnd) + 1 : size;
  if (!Number.isSafeInteger(end) || end <= start) return 'unsatisfiable';
  return { start, end: Math.min(end, size) };
}

/**
 * 区间流式读文件。`cleanupAfter` 在读完或出错时调用一次；可续传的下载会话不该传它——
 * 读到文件尾只说明字节发出去了，不代表客户端收下了，回收要等客户端显式 DELETE 或 TTL。
 */
export function streamFileRange(
  path: string,
  range: ContentRange | null,
  cleanupAfter: () => void = () => {}
): ReadableStream<Uint8Array> | null {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = openRange(path, range?.start ?? 0, range?.end).getReader();
  } catch {
    cleanupAfter();
    return null;
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          cleanupAfter();
          return;
        }
        controller.enqueue(value);
      } catch (e) {
        controller.error(e);
        cleanupAfter();
      }
    },
    cancel() {
      void reader.cancel();
      cleanupAfter();
    },
  });
}

export function streamTempFile(
  tmpPath: string,
  cleanupAfter: () => void
): ReadableStream<Uint8Array> | null {
  return streamFileRange(tmpPath, null, cleanupAfter);
}

export function ndjsonResponse(handlers: {
  start: (emit: (obj: unknown) => void, close: () => void) => void | Promise<void>;
  cancel?: () => void;
}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
        } catch {
          // 控制器已关闭（客户端断开）
        }
      };
      const close = () => {
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      };
      return handlers.start(emit, close);
    },
    cancel() {
      handlers.cancel?.();
    },
  });
  return new Response(stream, { status: 200, headers: NDJSON_HEADERS });
}
