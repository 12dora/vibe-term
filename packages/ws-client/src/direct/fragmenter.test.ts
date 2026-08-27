import { describe, expect, test } from 'bun:test';
import {
  FRAGMENT_HEADER_SIZE,
  FRAGMENT_PAYLOAD_SIZE,
  FrameReassembler,
  fragmentFrame,
} from './fragmenter';

function payload(size: number, seed = 1): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed) & 0xff;
  return bytes;
}

describe('fragmentFrame', () => {
  test('小于分片上限时只产出 1 片，头部为 [frameId u32][idx u16][total u16] LE', () => {
    const parts = fragmentFrame(0x01020304, payload(10));
    expect(parts.length).toBe(1);
    const head = parts[0] as Uint8Array;
    expect(head.byteLength).toBe(FRAGMENT_HEADER_SIZE + 10);
    expect(Array.from(head.subarray(0, 8))).toEqual([0x04, 0x03, 0x02, 0x01, 0, 0, 1, 0]);
  });

  test('空载荷也产出 1 片（total=1），重组得到空帧', () => {
    const parts = fragmentFrame(7, new Uint8Array(0));
    expect(parts.length).toBe(1);
    const out = new FrameReassembler().push(parts[0] as Uint8Array);
    expect(out).not.toBeNull();
    expect((out as Uint8Array).byteLength).toBe(0);
  });

  test('超过 64 KiB 按分片上限切分，idx / total 递增', () => {
    const parts = fragmentFrame(9, payload(FRAGMENT_PAYLOAD_SIZE * 2 + 5));
    expect(parts.length).toBe(3);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] as Uint8Array;
      expect(part[4]).toBe(i);
      expect(part[6]).toBe(3);
    }
    expect((parts[0] as Uint8Array).byteLength).toBe(FRAGMENT_HEADER_SIZE + FRAGMENT_PAYLOAD_SIZE);
    expect((parts[2] as Uint8Array).byteLength).toBe(FRAGMENT_HEADER_SIZE + 5);
  });
});

describe('FrameReassembler', () => {
  test('顺序重组还原原始字节', () => {
    const original = payload(FRAGMENT_PAYLOAD_SIZE * 2 + 123, 5);
    const reassembler = new FrameReassembler();
    const parts = fragmentFrame(42, original);
    let out: Uint8Array | null = null;
    for (const part of parts) out = reassembler.push(part) ?? out;
    expect(out).not.toBeNull();
    expect(Array.from(out as Uint8Array)).toEqual(Array.from(original));
  });

  test('乱序到达仍按 idx 归位', () => {
    const original = payload(FRAGMENT_PAYLOAD_SIZE + 7, 9);
    const parts = fragmentFrame(3, original);
    const reassembler = new FrameReassembler();
    expect(reassembler.push(parts[1] as Uint8Array)).toBeNull();
    const out = reassembler.push(parts[0] as Uint8Array);
    expect(Array.from(out as Uint8Array)).toEqual(Array.from(original));
  });

  test('两个帧交错到达互不干扰', () => {
    const a = fragmentFrame(1, payload(FRAGMENT_PAYLOAD_SIZE + 1, 2));
    const b = fragmentFrame(2, payload(FRAGMENT_PAYLOAD_SIZE + 2, 3));
    const reassembler = new FrameReassembler();
    expect(reassembler.push(a[0] as Uint8Array)).toBeNull();
    expect(reassembler.push(b[0] as Uint8Array)).toBeNull();
    expect(reassembler.push(b[1] as Uint8Array)).not.toBeNull();
    expect(reassembler.push(a[1] as Uint8Array)).not.toBeNull();
  });

  test('重复分片被忽略，畸形头（total=0 / idx 越界 / 长度不足）返回 null', () => {
    const parts = fragmentFrame(5, payload(FRAGMENT_PAYLOAD_SIZE + 1));
    const reassembler = new FrameReassembler();
    reassembler.push(parts[0] as Uint8Array);
    expect(reassembler.push(parts[0] as Uint8Array)).toBeNull();

    expect(reassembler.push(new Uint8Array(4))).toBeNull();
    const badTotal = new Uint8Array(FRAGMENT_HEADER_SIZE);
    expect(reassembler.push(badTotal)).toBeNull();
    const badIdx = new Uint8Array([9, 0, 0, 0, 3, 0, 2, 0]);
    expect(reassembler.push(badIdx)).toBeNull();
  });

  test('超时的半截帧被清理，后续同 frameId 的分片重新计数', () => {
    let now = 0;
    const reassembler = new FrameReassembler({ timeoutMs: 100, now: () => now });
    const parts = fragmentFrame(11, payload(FRAGMENT_PAYLOAD_SIZE + 1));
    reassembler.push(parts[0] as Uint8Array);
    now = 1000;
    // 超时后第二片到达时前一片已被清掉，集不齐 → null
    expect(reassembler.push(parts[1] as Uint8Array)).toBeNull();
  });

  test('在途帧数超过上限时淘汰最旧的', () => {
    const reassembler = new FrameReassembler({ maxInFlight: 2 });
    const frames = [1, 2, 3].map((id) => fragmentFrame(id, payload(FRAGMENT_PAYLOAD_SIZE + 1, id)));
    for (const parts of frames) reassembler.push(parts[0] as Uint8Array);
    // frameId=1 已被淘汰
    expect(reassembler.push((frames[0] as Uint8Array[])[1] as Uint8Array)).toBeNull();
    expect(reassembler.push((frames[2] as Uint8Array[])[1] as Uint8Array)).not.toBeNull();
  });
});
