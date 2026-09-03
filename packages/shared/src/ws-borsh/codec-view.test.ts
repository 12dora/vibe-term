import { describe, expect, it } from 'bun:test';
import { decodeEnvelope, decodeEnvelopeView, encodeEnvelope, encodePayload } from './codec';
import { WsBorshError } from './errors';
import { KIND_CLIPBOARD_WRITE } from './kind';
import { ClipboardWriteSchema } from './schema';

// 本组用例只验 envelope 头部解析，payload 用任意已登记 kind 的真实载荷即可。
function framePayload(data: Uint8Array): Uint8Array {
  return encodePayload(ClipboardWriteSchema, {
    deviceId: 'dev-1',
    paneId: '%1',
    text: Array.from(data, (byte) => byte.toString(16)).join(''),
  });
}

function frameOf(data: Uint8Array): Uint8Array {
  return encodeEnvelope(KIND_CLIPBOARD_WRITE, framePayload(data), 7);
}

describe('decodeEnvelopeView', () => {
  it('与 decodeEnvelope 结果一致，且 payload 借用原始缓冲', () => {
    const frame = frameOf(new Uint8Array([1, 2, 3, 4]));
    const view = decodeEnvelopeView(frame);
    expect(view).toEqual(decodeEnvelope(frame));
    expect(view.payload.buffer).toBe(frame.buffer);
    expect(decodeEnvelope(frame).payload.buffer).not.toBe(frame.buffer);
  });

  it('尾部多余字节与 decodeEnvelope 一样被忽略', () => {
    const frame = frameOf(new Uint8Array([9]));
    const padded = new Uint8Array(frame.length + 5);
    padded.set(frame);
    padded.fill(0xab, frame.length);
    expect(decodeEnvelopeView(padded)).toEqual(decodeEnvelope(padded));
  });

  it('过短帧 / 错误 magic / 头部截断 / payload 截断都抛 WsBorshError', () => {
    const frame = frameOf(new Uint8Array([1, 2, 3, 4]));
    for (const bad of [
      new Uint8Array([1, 2, 3]),
      new Uint8Array(16),
      frame.subarray(0, 14),
      frame.subarray(0, frame.length - 1),
    ]) {
      expect(() => decodeEnvelopeView(bad)).toThrow(WsBorshError);
      expect(() => decodeEnvelope(bad)).toThrow(WsBorshError);
    }
  });

  it('超大 payload 长度前缀被拒绝', () => {
    const frame = frameOf(new Uint8Array([1, 2, 3, 4]));
    new DataView(frame.buffer, frame.byteOffset).setUint32(12, 0xffffffff, true);
    expect(() => decodeEnvelopeView(frame)).toThrow(WsBorshError);
    expect(() => decodeEnvelope(frame)).toThrow(WsBorshError);
  });
});
