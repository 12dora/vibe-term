// 各测试套共用的 WS 假件：手工驱动的 transport 与 HELLO_S2C 帧构造器。
// 仅供 *.test.ts 使用，不从包入口导出。

import { wsBorsh } from '@tmex/shared';
import type { WebSocketLike } from './client';

export interface FakeSocketOptions {
  /**
   * true 时只接受二进制帧（收到文本帧直接抛），并把每帧**复制**成 Uint8Array 存进 `sent`，
   * 供直接解码；false（缺省）时按调用方传入的原样记录。
   */
  binary?: boolean;
}

interface FakeSocketBase extends WebSocketLike {
  /** 测试需要手工推进；接口里是只读的，这里放开 */
  readyState: number;
  closeCount: number;
  /** 模拟连接建立：先转 OPEN，再回调，顺序与浏览器一致。 */
  open(): void;
  /** 模拟对端断开：先落 CLOSED，再派发 onclose。 */
  simulateClose(): void;
  /** 把一帧二进制投递给 onmessage。 */
  deliver(frame: Uint8Array): void;
}

export interface FakeSocket extends FakeSocketBase {
  readonly sent: Array<ArrayBufferLike | ArrayBufferView | string>;
}

export interface BinaryFakeSocket extends FakeSocketBase {
  readonly sent: Uint8Array[];
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function copyToUint8Array(data: ArrayBufferLike | ArrayBufferView): Uint8Array {
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  }
  return new Uint8Array(data).slice();
}

export function createFakeSocket(options: { binary: true }): BinaryFakeSocket;
export function createFakeSocket(options?: FakeSocketOptions): FakeSocket;
export function createFakeSocket(options: FakeSocketOptions = {}): FakeSocket | BinaryFakeSocket {
  const sent: Array<ArrayBufferLike | ArrayBufferView | string> = [];
  const socket: FakeSocket = {
    readyState: 0,
    binaryType: 'blob',
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    sent,
    closeCount: 0,

    send(data) {
      if (!options.binary) {
        sent.push(data);
        return;
      }
      if (typeof data === 'string') throw new Error('unexpected text frame');
      sent.push(copyToUint8Array(data));
    },

    close() {
      socket.closeCount += 1;
      socket.readyState = 3;
    },

    open() {
      socket.readyState = 1;
      socket.onopen?.();
    },

    simulateClose() {
      socket.readyState = 3;
      socket.onclose?.();
    },

    deliver(frame) {
      socket.onmessage?.({ data: toArrayBuffer(frame) });
    },
  };
  return socket;
}

export interface HelloFrameOptions {
  capabilities?: readonly string[];
  serverVersion?: string;
  maxFrameBytes?: number;
  heartbeatIntervalMs?: number;
  seq?: number;
}

/** 构造一帧 HELLO_S2C；缺省值对应「不支持任何能力的老网关」。 */
export function helloFrame(options: HelloFrameOptions = {}): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.HelloS2CSchema, {
    serverImpl: 'tmex-gateway',
    serverVersion: options.serverVersion ?? '0.1.0',
    selectedVersion: 1,
    maxFrameBytes: options.maxFrameBytes ?? 1048576,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 5000,
    capabilities: [...(options.capabilities ?? [])],
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_S2C, payload, options.seq ?? 1);
}
