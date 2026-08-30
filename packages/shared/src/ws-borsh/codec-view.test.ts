import { describe, expect, it } from 'bun:test';
import {
  decodeEnvelope,
  decodeEnvelopeView,
  decodePayload,
  decodeTermOutputView,
  encodeEnvelope,
  encodePayload,
} from './codec';
import { WsBorshError } from './errors';
import { TermOutputSchema } from './schema';

function termOutputPayload(data: Uint8Array, deviceId = 'dev-1', paneId = '%1'): Uint8Array {
  return encodePayload(TermOutputSchema, { deviceId, paneId, encoding: 0, data });
}

function frameOf(data: Uint8Array): Uint8Array {
  return encodeEnvelope(0x0401, termOutputPayload(data), 7);
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

describe('decodeTermOutputView', () => {
  it('与 decodePayload 结果一致，且 data 借用原始缓冲', () => {
    const data = new Uint8Array([10, 20, 30, 40, 50]);
    const payload = termOutputPayload(data, '设备-1', '%42');
    const view = decodeTermOutputView(payload);
    expect(view).toEqual(decodePayload(TermOutputSchema, payload));
    expect(view.data.buffer).toBe(payload.buffer);
    expect(decodePayload(TermOutputSchema, payload).data.buffer).not.toBe(payload.buffer);
  });

  it('空 data 与尾部多余字节的行为与 decodePayload 一致', () => {
    const payload = termOutputPayload(new Uint8Array());
    expect(decodeTermOutputView(payload)).toEqual(decodePayload(TermOutputSchema, payload));

    const padded = new Uint8Array(payload.length + 3);
    padded.set(payload);
    padded.fill(0x7f, payload.length);
    expect(decodeTermOutputView(padded)).toEqual(decodePayload(TermOutputSchema, padded));
  });

  it('截断的 payload 抛 WsBorshError（与 decodePayload 同类错误）', () => {
    const payload = termOutputPayload(new Uint8Array([1, 2, 3, 4]));
    for (const cut of [2, 6, payload.length - 5, payload.length - 1]) {
      const truncated = payload.subarray(0, cut);
      expect(() => decodeTermOutputView(truncated)).toThrow(WsBorshError);
      expect(() => decodePayload(TermOutputSchema, truncated)).toThrow(WsBorshError);
    }
  });

  it('超大 data 长度前缀被拒绝', () => {
    const payload = termOutputPayload(new Uint8Array([1, 2, 3, 4]));
    const dataLengthOffset = payload.length - 4 - 4;
    new DataView(payload.buffer, payload.byteOffset).setUint32(dataLengthOffset, 0xffffffff, true);
    expect(() => decodeTermOutputView(payload)).toThrow(WsBorshError);
    expect(() => decodePayload(TermOutputSchema, payload)).toThrow(WsBorshError);
  });

  it('整帧端到端零拷贝：data 视图指回 WebSocket 帧缓冲', () => {
    const data = new Uint8Array(64).fill(0x41);
    const frame = frameOf(data);
    const view = decodeTermOutputView(decodeEnvelopeView(frame).payload);
    expect(view.data.buffer).toBe(frame.buffer);
    expect(view.data).toEqual(data);
  });
});
