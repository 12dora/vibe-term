import { describe, expect, it } from 'bun:test';
import { EC_CHUNK_BYTES, StdinOutbox } from './index';

const seq = (size: number, start = 0) => new Uint8Array(size).map((_, i) => (start + i) % 256);

function flatten(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.byteLength;
  }
  return out;
}

describe('StdinOutbox', () => {
  it('tracks sent, acked and unacked', () => {
    const box = new StdinOutbox();
    expect(box.push(seq(10))).toBe(10);
    expect(box.push(seq(5))).toBe(15);
    expect(box.sent).toBe(15);
    expect(box.acked).toBe(0);
    expect(box.unacked).toBe(15);
    expect(box.ack(12)).toBe(true);
    expect(box.acked).toBe(12);
    expect(box.unacked).toBe(3);
  });

  it('ignores empty pushes', () => {
    const box = new StdinOutbox();
    expect(box.push(new Uint8Array(0))).toBe(0);
    expect(box.pendingFrom(0)).toEqual([]);
  });

  it('rejects acks beyond sent and ignores stale ones', () => {
    const box = new StdinOutbox();
    box.push(seq(10));
    expect(box.ack(11)).toBe(false);
    expect(box.ack(-1)).toBe(false);
    box.ack(6);
    expect(box.ack(2)).toBe(true);
    expect(box.acked).toBe(6);
  });

  it('returns the unacked bytes from an offset', () => {
    const box = new StdinOutbox();
    box.push(seq(10));
    box.push(seq(10, 10));
    box.ack(4);
    expect(Array.from(flatten(box.pendingFrom(4)!))).toEqual(Array.from(seq(16, 4)));
    expect(Array.from(flatten(box.pendingFrom(13)!))).toEqual(Array.from(seq(7, 13)));
    expect(box.pendingFrom(20)).toEqual([]);
  });

  it('returns null outside [acked, sent]', () => {
    const box = new StdinOutbox();
    box.push(seq(10));
    box.ack(5);
    expect(box.pendingFrom(4)).toBeNull();
    expect(box.pendingFrom(11)).toBeNull();
    expect(box.pendingFrom(Number.NaN)).toBeNull();
  });

  it('splits large data into chunks of at most 64 KiB', () => {
    const box = new StdinOutbox();
    const size = EC_CHUNK_BYTES * 2 + 123;
    box.push(seq(size));
    const parts = box.pendingFrom(0)!;
    expect(parts.map((part) => part.byteLength)).toEqual([EC_CHUNK_BYTES, EC_CHUNK_BYTES, 123]);
    expect(flatten(parts)).toEqual(seq(size));
  });

  it('chunks from a mid-piece offset', () => {
    const box = new StdinOutbox();
    box.push(seq(EC_CHUNK_BYTES * 3));
    const parts = box.pendingFrom(10)!;
    expect(parts.every((part) => part.byteLength <= EC_CHUNK_BYTES)).toBe(true);
    expect(flatten(parts)).toEqual(seq(EC_CHUNK_BYTES * 3 - 10, 10));
  });

  it('frees acked data while preserving the remainder after a partial ack', () => {
    const box = new StdinOutbox();
    box.push(seq(8));
    box.push(seq(8, 8));
    box.ack(11);
    expect(Array.from(flatten(box.pendingFrom(11)!))).toEqual(Array.from(seq(5, 11)));
    box.ack(16);
    expect(box.unacked).toBe(0);
    expect(box.pendingFrom(16)).toEqual([]);
  });

  it('survives many pushes and acks (compaction)', () => {
    const box = new StdinOutbox();
    for (let i = 0; i < 2000; i += 1) box.push(seq(3, i * 3));
    box.ack(4500);
    expect(box.unacked).toBe(1500);
    expect(flatten(box.pendingFrom(4500)!)).toEqual(seq(1500, 4500));
    box.push(seq(2));
    expect(box.sent).toBe(6002);
  });
});
