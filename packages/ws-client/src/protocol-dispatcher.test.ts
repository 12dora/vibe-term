import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { type BorshMessage, type ChunkProgress, ProtocolDispatcher } from './protocol-dispatcher';

interface Recorder {
  dispatcher: ProtocolDispatcher;
  messages: BorshMessage[];
  progress: ChunkProgress[];
  hellos: Array<readonly string[]>;
  helloFailures: string[];
  pongs: number;
}

function createRecorder(): Recorder {
  const messages: BorshMessage[] = [];
  const progress: ChunkProgress[] = [];
  const hellos: Array<readonly string[]> = [];
  const helloFailures: string[] = [];
  let pongs = 0;
  const dispatcher = new ProtocolDispatcher({
    onMessage: (message) => messages.push(message),
    onChunkProgress: (item) => progress.push(item),
    onHello: (capabilities) => hellos.push(capabilities),
    onHelloFailure: (error) => helloFailures.push(error.message),
    onPong: () => {
      pongs += 1;
    },
  });
  return {
    dispatcher,
    messages,
    progress,
    hellos,
    helloFailures,
    get pongs() {
      return pongs;
    },
  };
}

function frame(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('ProtocolDispatcher', () => {
  test('忽略文本帧与无 magic 的二进制帧', () => {
    const rec = createRecorder();
    rec.dispatcher.handleFrame('legacy json');
    rec.dispatcher.handleFrame(frame(new Uint8Array([9, 9, 9, 9])));
    expect(rec.messages).toEqual([]);
  });

  test('业务帧原样上抛 kind/seq/payload', () => {
    const rec = createRecorder();
    const payload = new Uint8Array([7, 7]);
    rec.dispatcher.handleFrame(
      frame(wsBorsh.encodeEnvelope(wsBorsh.KIND_TERM_OUTPUT, payload, 12))
    );
    expect(rec.messages).toEqual([{ kind: wsBorsh.KIND_TERM_OUTPUT, seq: 12, payload }]);
  });

  test('PONG 与 HELLO 分流到各自回调', () => {
    const rec = createRecorder();
    rec.dispatcher.handleFrame(
      frame(wsBorsh.encodeEnvelope(wsBorsh.KIND_PONG, new Uint8Array(), 1))
    );
    expect(rec.pongs).toBe(1);

    const hello = wsBorsh.encodePayload(wsBorsh.schema.HelloS2CSchema, {
      serverImpl: 'tmex-gateway',
      serverVersion: '0.1.0',
      selectedVersion: 1,
      maxFrameBytes: 1024,
      heartbeatIntervalMs: 5000,
      capabilities: ['a', 'b'],
    });
    rec.dispatcher.handleFrame(frame(wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_S2C, hello, 2)));
    expect(rec.hellos).toEqual([['a', 'b']]);
    expect(rec.helloFailures).toEqual([]);
  });

  test('HELLO 解码失败走 onHelloFailure', () => {
    const rec = createRecorder();
    rec.dispatcher.handleFrame(
      frame(wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_S2C, new Uint8Array([0xff]), 3))
    );
    expect(rec.helloFailures).toEqual(['HELLO negotiation failed']);
  });

  test('reset 后旧分片流不再重组', () => {
    const rec = createRecorder();
    const payload = new Uint8Array(200).fill(4);
    const split = wsBorsh.splitPayloadIntoChunks(payload, wsBorsh.KIND_TERM_HISTORY, 3, {
      maxFrameBytes: 96,
      chunkStreamId: 1,
    });
    const [first, ...rest] = split.chunks;
    rec.dispatcher.handleFrame(
      frame(wsBorsh.encodeChunk(first as (typeof split.chunks)[number], 1))
    );
    expect(rec.progress.length).toBe(1);

    rec.dispatcher.reset();
    for (const [index, chunk] of rest.entries()) {
      rec.dispatcher.handleFrame(frame(wsBorsh.encodeChunk(chunk, index + 2)));
    }
    expect(rec.messages).toEqual([]);
  });
});
