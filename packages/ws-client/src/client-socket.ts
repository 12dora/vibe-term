// WS 传输层的最小契约与缺省实现：端点推导、readyState 常量、socket 工厂、字节视图转换。
// 与协议、连接状态都无关，独立于 `client.ts` 的门面存在。

// 惰性求值：允许在非浏览器环境 import 本模块，也允许宿主在构造时注入自定义端点
export function defaultWsUrl(): string {
  return `${typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${typeof window !== 'undefined' ? window.location.host : ''}/ws`;
}

// WHATWG 规定的 readyState 取值。用本地常量而非全局 WebSocket 的静态属性：
// 注入的 transport 不必是 WebSocket 的实例，非浏览器环境下全局 WebSocket 也未必存在。
export const WS_CONNECTING = 0;
export const WS_OPEN = 1;

/**
 * 浏览器 WebSocket 的最小结构子集。宿主可据此把 ws-borsh 帧承载在自定义通道上，
 * 只要实现遵循 WHATWG 的 readyState 取值约定。
 */
export interface WebSocketLike {
  readonly readyState: number;
  binaryType: 'blob' | 'arraybuffer';
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: ArrayBuffer | string }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  send(data: ArrayBufferLike | ArrayBufferView | string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => WebSocketLike;

// DOM 的 onmessage 事件参数是 MessageEvent，在 strictFunctionTypes 下与 WebSocketLike 的
// 结构化参数互不可赋值（参数逆变）。把这层不兼容收敛在此一处断言，不向接口撒 any。
export const defaultSocketFactory: SocketFactory = (url) =>
  new WebSocket(url) as unknown as WebSocketLike;

/** 屏障内部一律用 Uint8Array；交回 dispatcher 时零拷贝还原成 ArrayBuffer。 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}
