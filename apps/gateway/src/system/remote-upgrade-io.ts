// 远程升级作业的收发管道：请求脱壳、包体读流、退避睡眠、上游错误摘要。
// 都是与作业状态机无关的纯管道，单独放一处让状态机文件只剩流程。

import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';

/** 作业跑在原请求之外，只带鉴权必需的头，避免把已关闭请求的 body / signal 拖进来。 */
export function detachRequest(req: Request): Request {
  const headers = new Headers();
  const cookie = req.headers.get('cookie');
  if (cookie) headers.set('cookie', cookie);
  const origin = req.headers.get('origin');
  if (origin) headers.set('origin', origin);
  return new Request(req.url, { headers });
}

/** `start` 用于续传：只读没推过去的那一段。 */
export function fileReadableStream(path: string, start = 0): ReadableStream<Uint8Array> {
  const size = statSync(path).size;
  if (size === 0 || start >= size) {
    return new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
  }
  return Readable.toWeb(
    start > 0 ? createReadStream(path, { start }) : createReadStream(path)
  ) as unknown as ReadableStream<Uint8Array>;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 把上游回包压成一行可读结论：优先 `code` / `error` 字段，拿不到就用原文。 */
export async function describeUpstream(res: Response): Promise<string> {
  const text = (await res.text().catch(() => '')).slice(0, 800);
  let extra = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const code = (parsed as { code?: unknown }).code;
      const error = (parsed as { error?: unknown }).error;
      extra = [typeof code === 'string' ? code : null, typeof error === 'string' ? error : null]
        .filter(Boolean)
        .join(' ');
    }
  } catch {
    // keep raw text
  }
  return `HTTP ${res.status}${extra ? ` ${extra}` : ''}`.trim();
}
