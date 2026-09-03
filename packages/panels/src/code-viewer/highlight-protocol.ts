// 主线程 <-> 高亮 worker 的消息协议。

export interface HighlightWorkerRequest {
  id: number;
  code: string;
  fileName: string;
}

export interface HighlightWorkerResponse {
  id: number;
  html: string | null;
}

export interface HighlightWorkerLike {
  postMessage(message: HighlightWorkerRequest): void;
  addEventListener(
    type: 'message',
    handler: (event: MessageEvent<HighlightWorkerResponse>) => void
  ): void;
  addEventListener(type: 'error' | 'messageerror', handler: () => void): void;
  terminate(): void;
}
