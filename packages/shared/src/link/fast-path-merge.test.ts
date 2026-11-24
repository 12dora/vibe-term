import { describe, expect, it } from 'bun:test';
import {
  FAST_COPY_MAX_BYTES,
  FastPathMerge,
  FastPathSender,
  decodeFastCopy,
  encodeFastCopy,
  readFastCopyIndex,
} from './fast-path-merge';

const msg = (n: number, size = 4) => new Uint8Array(size).fill(n & 0xff);

function harness(opts?: Partial<ConstructorParameters<typeof FastPathMerge>[0]>) {
  const delivered: number[] = [];
  const desync: number[] = [];
  const merge = new FastPathMerge({
    onDeliver: (bytes) => delivered.push(bytes[0] ?? -1),
    onDesync: (index) => desync.push(index),
    ...opts,
  });
  return { merge, delivered, desync };
}

describe('FastPathMerge', () => {
  it('delivers reliable-only traffic in order', () => {
    const { merge, delivered } = harness();
    for (let i = 0; i < 5; i++) merge.pushReliable(msg(i));
    expect(delivered).toEqual([0, 1, 2, 3, 4]);
    expect(merge.stats()).toMatchObject({ deliveredEarly: 0, droppedDup: 0, fastLate: 0 });
  });

  it('fast copy first delivers early and drops the later reliable duplicate', () => {
    const { merge, delivered } = harness();
    merge.pushFast(0, msg(0));
    merge.pushFast(1, msg(1));
    expect(delivered).toEqual([0, 1]);
    merge.pushReliable(msg(0));
    merge.pushReliable(msg(1));
    merge.pushReliable(msg(2));
    expect(delivered).toEqual([0, 1, 2]);
    expect(merge.stats()).toMatchObject({ deliveredEarly: 2, droppedDup: 2, ahead: 0 });
  });

  it('reliable first drops the late fast copy', () => {
    const { merge, delivered } = harness();
    merge.pushReliable(msg(0));
    merge.pushFast(0, msg(0));
    expect(delivered).toEqual([0]);
    expect(merge.stats().fastLate).toBe(1);
  });

  it('buffers a gap and drains once the missing index arrives', () => {
    const { merge, delivered } = harness();
    merge.pushReliable(msg(0));
    merge.pushFast(2, msg(2));
    merge.pushFast(3, msg(3));
    expect(delivered).toEqual([0]);
    expect(merge.stats().buffered).toBe(2);
    merge.pushReliable(msg(1));
    expect(delivered).toEqual([0, 1, 2, 3]);
    merge.pushReliable(msg(2));
    merge.pushReliable(msg(3));
    merge.pushReliable(msg(4));
    expect(delivered).toEqual([0, 1, 2, 3, 4]);
    expect(merge.stats()).toMatchObject({ deliveredEarly: 2, droppedDup: 2, buffered: 0 });
  });

  it('ignores duplicate fast copies', () => {
    const { merge, delivered } = harness();
    merge.pushFast(1, msg(1));
    merge.pushFast(1, msg(1));
    merge.pushFast(0, msg(0));
    merge.pushFast(0, msg(0));
    expect(delivered).toEqual([0, 1]);
    expect(merge.stats().fastLate).toBe(2);
  });

  it('drops buffered copies on overflow; reliable still delivers everything', () => {
    const { merge, delivered } = harness({ maxBuffered: 2 });
    merge.pushFast(1, msg(1));
    merge.pushFast(2, msg(2));
    merge.pushFast(3, msg(3));
    expect(merge.stats()).toMatchObject({ bufferOverflows: 1, buffered: 0 });
    for (let i = 0; i < 4; i++) merge.pushReliable(msg(i));
    expect(delivered).toEqual([0, 1, 2, 3]);
  });

  it('respects the byte budget for buffered copies', () => {
    const { merge } = harness({ maxBufferedBytes: 10 });
    merge.pushFast(1, msg(1, 6));
    merge.pushFast(2, msg(2, 6));
    expect(merge.stats()).toMatchObject({ bufferOverflows: 1, buffered: 0 });
  });

  it('stops early delivery once too far ahead of the reliable stream', () => {
    const { merge, delivered } = harness({ maxAhead: 2 });
    merge.pushFast(0, msg(0));
    merge.pushFast(1, msg(1));
    merge.pushFast(2, msg(2));
    expect(delivered).toEqual([0, 1]);
    merge.pushReliable(msg(0));
    merge.pushReliable(msg(1));
    merge.pushReliable(msg(2));
    expect(delivered).toEqual([0, 1, 2]);
  });

  it('drains a copy left behind when the ahead window was full', () => {
    const { merge, delivered } = harness({ maxAhead: 1 });
    merge.pushFast(1, msg(1));
    merge.pushFast(0, msg(0));
    expect(delivered).toEqual([0]);
    expect(merge.stats()).toMatchObject({ buffered: 1, ahead: 1 });
    merge.pushReliable(msg(0));
    expect(delivered).toEqual([0, 1]);
    expect(merge.stats()).toMatchObject({ buffered: 0, ahead: 1 });
    merge.pushReliable(msg(1));
    merge.pushReliable(msg(2));
    expect(delivered).toEqual([0, 1, 2]);
    expect(merge.stats()).toMatchObject({ buffered: 0, ahead: 0, droppedDup: 2, desync: 0 });
  });

  it('dropIfLate counts and rejects only indices already delivered', () => {
    const { merge } = harness();
    merge.pushReliable(msg(0));
    expect(merge.dropIfLate(0)).toBe(true);
    expect(merge.dropIfLate(1)).toBe(false);
    expect(merge.dropIfLate(5)).toBe(false);
    expect(merge.stats().fastLate).toBe(1);
  });

  it('interleaves large reliable-only messages with small fast-copied ones', () => {
    const { merge, delivered } = harness();
    merge.pushReliable(msg(0));
    merge.pushFast(2, msg(2));
    merge.pushFast(4, msg(4));
    expect(delivered).toEqual([0]);
    merge.pushReliable(msg(1, 4096));
    expect(delivered).toEqual([0, 1, 2]);
    merge.pushReliable(msg(2));
    merge.pushReliable(msg(3, 4096));
    expect(delivered).toEqual([0, 1, 2, 3, 4]);
    merge.pushReliable(msg(4));
    merge.pushReliable(msg(5));
    expect(delivered).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('handles u32 index wrap', () => {
    const start = 0xffff_fffe;
    const { merge, delivered } = harness({ startIndex: start });
    merge.pushFast(0, msg(2));
    merge.pushFast(0xffff_ffff, msg(1));
    expect(delivered).toEqual([]);
    merge.pushReliable(msg(0));
    expect(delivered).toEqual([0, 1, 2]);
    merge.pushReliable(msg(1));
    merge.pushReliable(msg(2));
    merge.pushReliable(msg(3));
    expect(delivered).toEqual([0, 1, 2, 3]);
    expect(merge.next).toBe(2);
    expect(merge.stats().desync).toBe(0);
  });

  it('reports desync when a reliable duplicate does not match the early copy', () => {
    const { merge, delivered, desync } = harness();
    merge.pushFast(0, msg(7));
    merge.pushReliable(msg(8));
    expect(desync).toEqual([0]);
    merge.pushReliable(msg(1));
    merge.pushFast(1, msg(1));
    expect(delivered).toEqual([7]);
    expect(merge.stats().desync).toBe(1);
  });

  it('pushFastMessage decodes the index header and ignores short messages', () => {
    const { merge, delivered } = harness();
    expect(readFastCopyIndex(encodeFastCopy(0x0102_0304, msg(1)))).toBe(0x0102_0304);
    expect(readFastCopyIndex(new Uint8Array(4))).toBeNull();
    merge.pushFastMessage(new Uint8Array([0, 0, 0]));
    merge.pushFastMessage(encodeFastCopy(0, msg(5)));
    expect(delivered).toEqual([5]);
  });
});

describe('FastPathSender', () => {
  it('counts every reliable message and copies only small ones on request', () => {
    const sender = new FastPathSender();
    expect(sender.noteReliable(msg(0), false)).toBeNull();
    const copy = sender.noteReliable(msg(1), true);
    expect(copy && decodeFastCopy(copy)).toEqual({ index: 1, bytes: msg(1) });
    expect(sender.noteReliable(msg(2, FAST_COPY_MAX_BYTES + 1), true)).toBeNull();
    const last = sender.noteReliable(msg(3), true);
    expect(last && decodeFastCopy(last)?.index).toBe(3);
    expect(sender.next).toBe(4);
  });

  it('wraps the u32 index', () => {
    const sender = new FastPathSender({ startIndex: 0xffff_ffff });
    const a = sender.noteReliable(msg(0), true);
    const b = sender.noteReliable(msg(1), true);
    expect(a && decodeFastCopy(a)?.index).toBe(0xffff_ffff);
    expect(b && decodeFastCopy(b)?.index).toBe(0);
  });

  it('sender and merge agree end to end with random loss on the fast path', () => {
    const sender = new FastPathSender();
    const { merge, delivered } = harness();
    const copies: Array<Uint8Array> = [];
    const reliable: Uint8Array[] = [];
    for (let i = 0; i < 200; i++) {
      const bytes = msg(i, i % 7 === 0 ? FAST_COPY_MAX_BYTES + 10 : 8);
      reliable.push(bytes);
      const copy = sender.noteReliable(bytes, true);
      if (copy && i % 3 !== 0) copies.push(copy);
    }
    copies.reverse();
    for (const copy of copies.slice(0, 50)) merge.pushFastMessage(copy);
    for (const bytes of reliable) merge.pushReliable(bytes);
    for (const copy of copies.slice(50)) merge.pushFastMessage(copy);
    expect(delivered).toEqual(reliable.map((bytes) => bytes[0] ?? -1));
    expect(merge.stats().desync).toBe(0);
  });
});
