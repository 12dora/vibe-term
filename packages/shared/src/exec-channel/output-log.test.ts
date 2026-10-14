import { describe, expect, it } from 'bun:test';
import { EC_HEADER_BYTES, EcKind, FrameDecoder, OutputLog, encodeFrame } from './index';

const frameOf = (kind: number, size: number) => encodeFrame(kind, new Uint8Array(size).fill(size));

function filled(sizes: number[]): { log: OutputLog; offsets: number[] } {
  const log = new OutputLog();
  const offsets = [0];
  for (const size of sizes) offsets.push(log.append(frameOf(EcKind.STDOUT, size)));
  return { log, offsets };
}

const total = (parts: Uint8Array[]) => parts.reduce((sum, part) => sum + part.byteLength, 0);

describe('OutputLog', () => {
  it('counts full encoded bytes and returns the new sent offset', () => {
    const log = new OutputLog();
    expect(log.append(frameOf(EcKind.STDOUT, 10))).toBe(EC_HEADER_BYTES + 10);
    expect(log.append(frameOf(EcKind.STDERR, 0))).toBe(EC_HEADER_BYTES + 10 + EC_HEADER_BYTES);
    expect(log.sent).toBe(20);
    expect(log.acked).toBe(0);
    expect(log.unacked).toBe(20);
  });

  it('slices from any frame boundary including the end', () => {
    const { log, offsets } = filled([3, 4, 5]);
    for (let i = 0; i <= 3; i += 1) {
      const slice = log.sliceFrom(offsets[i]!);
      expect(slice).not.toBeNull();
      expect(total(slice!)).toBe(log.sent - offsets[i]!);
      expect(slice!.length).toBe(3 - i);
    }
  });

  it('slices decode back into the original logged frames', () => {
    const log = new OutputLog();
    log.append(frameOf(EcKind.STDOUT, 2));
    const mid = log.append(frameOf(EcKind.STDERR, 3));
    log.append(frameOf(EcKind.EXIT, 1));
    const decoder = new FrameDecoder();
    const frames = (log.sliceFrom(mid) ?? []).flatMap((part) => decoder.push(part));
    expect(frames.map((frame) => frame.kind)).toEqual([EcKind.EXIT]);
  });

  it('returns null for unaligned offsets', () => {
    const { log, offsets } = filled([3, 4]);
    expect(log.sliceFrom(offsets[1]! + 1)).toBeNull();
    expect(log.sliceFrom(offsets[1]! - 1)).toBeNull();
  });

  it('returns null outside [acked, sent] and for invalid numbers', () => {
    const { log, offsets } = filled([3, 4, 5]);
    expect(log.sliceFrom(log.sent + 1)).toBeNull();
    expect(log.sliceFrom(-1)).toBeNull();
    expect(log.sliceFrom(Number.NaN)).toBeNull();
    expect(log.sliceFrom(1.5)).toBeNull();
    log.ack(offsets[2]!);
    expect(log.sliceFrom(offsets[1]!)).toBeNull();
    expect(log.sliceFrom(offsets[2]!)).not.toBeNull();
  });

  it('ack drops whole frames below the offset and rejects offsets beyond sent', () => {
    const { log, offsets } = filled([3, 4, 5]);
    expect(log.ack(offsets[2]!)).toBe(true);
    expect(log.acked).toBe(offsets[2]!);
    expect(log.unacked).toBe(log.sent - offsets[2]!);
    expect(log.ack(log.sent + 1)).toBe(false);
    expect(log.acked).toBe(offsets[2]!);
  });

  it('ignores stale or invalid acks', () => {
    const { log, offsets } = filled([3, 4]);
    log.ack(offsets[2]!);
    expect(log.ack(offsets[1]!)).toBe(true);
    expect(log.acked).toBe(offsets[2]!);
    expect(log.ack(-1)).toBe(false);
    expect(log.ack(Number.NaN)).toBe(false);
  });

  it('keeps the partially acked frame replayable from the next boundary only', () => {
    const { log, offsets } = filled([10, 10]);
    log.ack(offsets[1]! - 2);
    expect(log.acked).toBe(offsets[1]! - 2);
    expect(log.sliceFrom(offsets[1]!)?.length).toBe(1);
    expect(log.sliceFrom(offsets[0]!)).toBeNull();
    expect(log.sliceFrom(log.acked)).toBeNull();
  });

  it('stays consistent across many appends and compactions', () => {
    const log = new OutputLog();
    const offsets = [0];
    for (let i = 0; i < 2000; i += 1) offsets.push(log.append(frameOf(EcKind.STDOUT, i % 7)));
    for (let i = 1; i <= 1500; i += 3) log.ack(offsets[i]!);
    const from = offsets[1500]!;
    expect(log.acked).toBeLessThanOrEqual(from);
    expect(log.sliceFrom(from)?.length).toBe(500);
    log.ack(log.sent);
    expect(log.unacked).toBe(0);
    expect(log.sliceFrom(log.sent)).toEqual([]);
    expect(log.append(frameOf(EcKind.EXIT, 1))).toBe(log.sent);
    expect(log.sliceFrom(log.acked)?.length).toBe(1);
  });
});
