// 带字节级上行进度的上传：fetch 拿不到请求体进度，只能走 XMLHttpRequest 的 `upload.onprogress`。
// 行为对齐 fetch：中止 → AbortError，网络错误 → TypeError，返回真正的 `Response`。

import type { RequestPurpose } from './client';
import { abortError } from './file-errors';

export interface UploadInit {
  method?: string;
  body: Blob;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** 请求用途，交给 ApiClient 的请求门。 */
  purpose?: RequestPurpose;
  /** 请求体已发出的字节数（相对本次请求）。 */
  onUploadProgress?: (loaded: number) => void;
}

/** 本模块用到的 XMLHttpRequest 子集（测试注入假件）。 */
export interface XhrLike {
  responseType: XMLHttpRequestResponseType;
  withCredentials: boolean;
  status: number;
  statusText: string;
  response: unknown;
  upload: { onprogress: ((e: { loaded: number }) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  getAllResponseHeaders(): string;
  send(body: Blob): void;
  abort(): void;
}

export type XhrCtor = new () => XhrLike;

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

export function parseResponseHeaders(raw: string): Headers {
  const headers = new Headers();
  for (const line of raw.split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    try {
      headers.append(line.slice(0, at).trim(), line.slice(at + 1).trim());
    } catch {
      // 非法头名/值：与浏览器 fetch 一样丢弃
    }
  }
  return headers;
}

function toResponse(xhr: XhrLike): Response {
  const body = NULL_BODY_STATUS.has(xhr.status) ? null : (xhr.response as ArrayBuffer | null);
  return new Response(body, {
    status: xhr.status,
    statusText: xhr.statusText,
    headers: parseResponseHeaders(xhr.getAllResponseHeaders()),
  });
}

export function xhrUpload(Xhr: XhrCtor, url: string, init: UploadInit): Promise<Response> {
  const { signal, body, onUploadProgress } = init;
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<Response>((resolve, reject) => {
    const xhr = new Xhr();
    const onAbort = (): void => xhr.abort();
    const settle = (): void => signal?.removeEventListener('abort', onAbort);
    xhr.open(init.method ?? 'POST', url);
    xhr.responseType = 'arraybuffer';
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (e) => onUploadProgress?.(Math.min(e.loaded, body.size));
    xhr.onload = () => {
      settle();
      try {
        resolve(toResponse(xhr));
      } catch (err) {
        reject(err);
      }
    };
    xhr.onerror = () => {
      settle();
      reject(new TypeError('Network request failed'));
    };
    xhr.onabort = () => {
      settle();
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    xhr.send(body);
  });
}
