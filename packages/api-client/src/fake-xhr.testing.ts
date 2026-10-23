// 测试用 XMLHttpRequest 假件：脚本化每次 send 的上行进度与响应。

import type { XhrLike } from './xhr-upload';

export interface FakeXhrReply {
  status?: number;
  statusText?: string;
  headers?: string;
  body?: string;
  /** 'error' = 网络错误；'hang' = 一直不应答（等 abort） */
  outcome?: 'error' | 'hang';
  /** 依次触发的 upload.onprogress.loaded */
  progress?: number[];
}

export type FakeXhrScript = (xhr: FakeXhr, body: Blob) => FakeXhrReply | Promise<FakeXhrReply>;

export class FakeXhr implements XhrLike {
  static instances: FakeXhr[] = [];
  static script: FakeXhrScript = () => ({ status: 200 });

  responseType: XMLHttpRequestResponseType = '';
  withCredentials = false;
  status = 0;
  statusText = '';
  response: unknown = null;
  upload: { onprogress: ((e: { loaded: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  method = '';
  url = '';
  aborted = false;
  sentHeaders: Record<string, string> = {};
  private rawHeaders = '';

  constructor() {
    FakeXhr.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.sentHeaders[name] = value;
  }

  getAllResponseHeaders(): string {
    return this.rawHeaders;
  }

  abort(): void {
    this.aborted = true;
    queueMicrotask(() => this.onabort?.());
  }

  send(body: Blob): void {
    void Promise.resolve(FakeXhr.script(this, body)).then((reply) => {
      for (const loaded of reply.progress ?? []) this.upload.onprogress?.({ loaded });
      if (reply.outcome === 'hang' || this.aborted) return;
      if (reply.outcome === 'error') {
        this.onerror?.();
        return;
      }
      this.status = reply.status ?? 200;
      this.statusText = reply.statusText ?? '';
      this.rawHeaders = reply.headers ?? '';
      this.response = new TextEncoder().encode(reply.body ?? '').buffer;
      this.onload?.();
    });
  }
}

export function resetFakeXhr(script: FakeXhrScript = () => ({ status: 200 })): void {
  FakeXhr.instances = [];
  FakeXhr.script = script;
}
