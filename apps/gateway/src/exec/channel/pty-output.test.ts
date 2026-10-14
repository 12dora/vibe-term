import { describe, expect, test } from 'bun:test';
import { ExecChannelError } from './errors';
import { PtyOutput } from './pty-output';

const bytes = (...n: number[]) => new Uint8Array(n);
const filled = (size: number, value = 0) => new Uint8Array(size).fill(value);

function flowRecorder(options: ConstructorParameters<typeof PtyOutput>[0] = {}) {
  const calls: string[] = [];
  const out = new PtyOutput({
    ...options,
    pause: () => calls.push('pause'),
    resume: () => calls.push('resume'),
  });
  return { out, calls };
}

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

  test('a waiting reader gets data directly and never pauses the producer', async () => {
    const { out, calls } = flowRecorder({ highWater: 0, lowWater: 0 });
    const pending = out.read();
    expect(out.push(bytes(1))).toBe(false);
    expect(await pending).toEqual(bytes(1));
    expect(calls).toEqual([]);
  });
});

describe('PtyOutput flow control', () => {
  test('pauses above the high-water mark and resumes at the low-water mark', async () => {
    const { out, calls } = flowRecorder({ highWater: 10, lowWater: 4, hardCap: 1000 });
    out.push(filled(6));
    out.push(filled(4));
    expect(calls).toEqual([]);
    out.push(filled(1));
    expect(calls).toEqual(['pause']);
    expect(out.pausedByFlowControl).toBe(true);

    out.push(filled(3));
    expect(calls).toEqual(['pause']);

    await out.read();
    expect(calls).toEqual(['pause']);
    await out.read();
    expect(calls).toEqual(['pause', 'resume']);
    expect(out.pausedByFlowControl).toBe(false);
  });

  test('can pause again after a resume', async () => {
    const { out, calls } = flowRecorder({ highWater: 4, lowWater: 0, hardCap: 1000 });
    out.push(filled(5));
    await out.read();
    out.push(filled(5));
    await out.read();
    expect(calls).toEqual(['pause', 'resume', 'pause', 'resume']);
  });

  test('loses no data across pause and resume', async () => {
    const { out, calls } = flowRecorder({ highWater: 8, lowWater: 2, hardCap: 10_000 });
    const sent: number[] = [];
    for (let i = 0; i < 40; i++) {
      const chunk = filled(3, i + 1);
      sent.push(...chunk);
      out.push(chunk);
    }
    out.end();
    const received: number[] = [];
    for (;;) {
      const chunk = await out.read();
      if (chunk === null) break;
      received.push(...chunk);
    }
    expect(received).toEqual(sent);
    expect(calls).toEqual(['pause', 'resume']);
  });

  test('releasePause resumes once and is a no-op when not paused', () => {
    const { out, calls } = flowRecorder({ highWater: 2, lowWater: 0, hardCap: 100 });
    out.releasePause();
    expect(calls).toEqual([]);
    out.push(filled(3));
    out.releasePause();
    out.releasePause();
    expect(calls).toEqual(['pause', 'resume']);
  });

  test('stopFlowControl resumes and keeps the producer running afterwards', () => {
    const { out, calls } = flowRecorder({ highWater: 2, lowWater: 0, hardCap: 100 });
    out.push(filled(3));
    out.stopFlowControl();
    out.push(filled(3));
    expect(calls).toEqual(['pause', 'resume']);
  });

  test('end resumes a paused producer and still delivers the queue', async () => {
    const { out, calls } = flowRecorder({ highWater: 2, lowWater: 0, hardCap: 100 });
    out.push(bytes(1, 2, 3));
    out.end();
    expect(calls).toEqual(['pause', 'resume']);
    expect(await out.read()).toEqual(bytes(1, 2, 3));
    expect(await out.read()).toBeNull();
  });

  test('flow can be bound after construction', () => {
    const calls: string[] = [];
    const out = new PtyOutput({ highWater: 1, lowWater: 0, hardCap: 100 });
    out.flow = { pause: () => calls.push('pause'), resume: () => calls.push('resume') };
    out.push(bytes(1, 2));
    expect(calls).toEqual(['pause']);
  });
});

describe('PtyOutput hard cap', () => {
  test('delivers every queued chunk, then rejects once, then reports EOF', async () => {
    const { out } = flowRecorder({ highWater: 2, lowWater: 1, hardCap: 6 });
    expect(out.push(bytes(1, 2, 3))).toBe(false);
    expect(out.push(bytes(4, 5, 6))).toBe(false);
    expect(out.push(bytes(7))).toBe(true);
    expect(out.push(bytes(8))).toBe(false);
    expect(await out.read()).toEqual(bytes(1, 2, 3));
    expect(await out.read()).toEqual(bytes(4, 5, 6));
    expect(await out.read()).toEqual(bytes(7));
    const failure = await out.read().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ExecChannelError);
    expect((failure as ExecChannelError).code).toBe('exec_spawn_failed');
    expect((failure as ExecChannelError).message).toBe('pty output overflow');
    expect(await out.read()).toBeNull();
  });

  test('the failure survives end() until the queue has been consumed', async () => {
    const out = new PtyOutput({ highWater: 1, lowWater: 0, hardCap: 2 });
    expect(out.push(bytes(1, 2, 3))).toBe(true);
    out.end();
    expect(await out.read()).toEqual(bytes(1, 2, 3));
    await expect(out.read()).rejects.toBeInstanceOf(ExecChannelError);
    expect(await out.read()).toBeNull();
  });
});
