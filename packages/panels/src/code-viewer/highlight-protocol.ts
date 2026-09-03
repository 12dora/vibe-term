// 主线程 <-> 高亮 worker 的消息协议。
// 请求带 type：取消必须真的传到 worker，否则被取消的大文件仍会排在最新请求前面逐个跑完。

export interface HighlightRequestMessage {
  type: 'highlight';
  id: number;
  code: string;
  fileName: string;
}

export interface HighlightCancelMessage {
  type: 'cancel';
  id: number;
}

export type HighlightWorkerRequest = HighlightRequestMessage | HighlightCancelMessage;

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
