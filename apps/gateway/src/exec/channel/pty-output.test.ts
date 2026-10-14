import { describe, expect, test } from 'bun:test';
import { ExecChannelError } from './errors';
import { PtyOutput } from './pty-output';

const bytes = (...n: number[]) => new Uint8Array(n);

describe('PtyOutput', () => {
  test('delivers queued chunks in order, then null after end', async () => {
    const out = new PtyOutput();
    out.push(bytes(1));
    out.push(bytes(2, 3));
    out.end();
    expect(await out.read()).toEqual(bytes(1));
    expect(await out.read()).toEqual(bytes(2, 3));
    expect(await out.read()).toBeNull();
  });

  test('wakes a pending reader on push and on end', async () => {
    const out = new PtyOutput();
    const first = out.read();
    out.push(bytes(9));
    expect(await first).toEqual(bytes(9));
    const second = out.read();
    out.end();
    expect(await second).toBeNull();
  });

  test('copies pushed data so the producer may reuse its buffer', async () => {
    const out = new PtyOutput();
    const shared = bytes(1, 2);
    out.push(shared);
    shared[0] = 99;
    expect(await out.read()).toEqual(bytes(1, 2));
  });

  test('overflow fails the next read once, then reports EOF', async () => {
    const out = new PtyOutput(4);
    expect(out.push(bytes(1, 2, 3))).toBe(false);
    expect(out.push(bytes(4, 5))).toBe(true);
    await expect(out.read()).rejects.toBeInstanceOf(ExecChannelError);
    expect(await out.read()).toBeNull();
  });

  test('a waiting reader gets data directly and never counts toward the limit', async () => {
    const out = new PtyOutput(0);
    const pending = out.read();
    expect(out.push(bytes(1))).toBe(false);
    expect(await pending).toEqual(bytes(1));
  });
});
