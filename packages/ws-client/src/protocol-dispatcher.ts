// Borsh 帧分发：magic 校验、envelope 解码、分片重组与 HELLO/PONG 分流。
// 只负责协议语义，不持有连接状态；连接生命周期由 BorshWebSocketClient 管理。

import { wsBorsh } from '@tmex/shared';

export interface BorshMessage {
  kind: number;
  seq: number;
  payload: Uint8Array;
}

export interface ChunkProgress {
  streamId: number;
  originalKind: number;
  chunkIndex: number;
  totalChunks: number;
}

/** HELLO_S2C 里被客户端留存的协商结果。 */
export interface NegotiatedHello {
  capabilities: readonly string[];
  serverVersion: string;
}

export interface ProtocolDispatcherCallbacks {
  onMessage(message: BorshMessage): void;
  onChunkProgress(progress: ChunkProgress): void;
  onHello(hello: NegotiatedHello): void;
  onHelloFailure(error: Error): void;
  onPong(): void;
}

export class ProtocolDispatcher {
  private readonly reassembler = new wsBorsh.ChunkReassembler();

  constructor(private readonly callbacks: ProtocolDispatcherCallbacks) {}

  /** 丢弃未完成的分片流；连接关闭/重建时调用。 */
  reset(): void {
    this.reassembler.clear();
  }

  handleFrame(data: ArrayBuffer | string): void {
    if (typeof data === 'string') {
      // 忽略旧协议的文本消息
      return;
    }

    const buffer = new Uint8Array(data);

    if (!wsBorsh.checkMagic(buffer)) {
      console.warn('[borsh-client] Received message without magic, ignoring');
      return;
    }

    try {
      // 视图解码：payload 直接借用帧缓冲，TERM_OUTPUT 的 MiB 级字节不再逐帧 copy 两遍
      const envelope = wsBorsh.decodeEnvelopeView(buffer);

      if (envelope.kind === wsBorsh.KIND_CHUNK) {
        this.handleChunk(envelope.payload);
        return;
      }

      if (envelope.kind === wsBorsh.KIND_HELLO_S2C) {
        this.handleHello(envelope.payload);
        return;
      }

      if (envelope.kind === wsBorsh.KIND_PONG) {
        this.callbacks.onPong();
        return;
      }

      this.callbacks.onMessage({
        kind: envelope.kind,
        seq: envelope.seq,
        payload: envelope.payload,
      });
    } catch (err) {
      console.error('[borsh-client] Failed to decode message:', err);
    }
  }

  private handleChunk(payload: Uint8Array): void {
    const chunk = wsBorsh.decodeChunk(payload);
    const reassembled = this.reassembler.addChunk(chunk);

    this.callbacks.onChunkProgress({
      streamId: chunk.chunkStreamId,
      originalKind: chunk.originalKind,
      chunkIndex: chunk.chunkIndex,
      totalChunks: chunk.totalChunks,
    });

    if (reassembled) {
      this.callbacks.onMessage({
        kind: reassembled.kind,
        seq: reassembled.seq,
        payload: reassembled.payload,
      });
    }
  }

  private handleHello(payload: Uint8Array): void {
    try {
      const hello = wsBorsh.decodePayload(wsBorsh.schema.HelloS2CSchema, payload);
      this.callbacks.onHello({
        capabilities: hello.capabilities ?? [],
        serverVersion: hello.serverVersion ?? '',
      });
    } catch (err) {
      console.error('[borsh-client] Failed to decode HELLO_S2C:', err);
      this.callbacks.onHelloFailure(new Error('HELLO negotiation failed'));
    }
  }
}
