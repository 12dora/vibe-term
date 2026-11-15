import { describe, expect, test } from 'bun:test';

import type { ControlHealthInfo, ControlHealthKind, ControlHealthSink } from './control-health';
import { ControlModeCommandQueue } from './control-mode-capture';
import { createFakeClock } from './control-queue-test-helpers';
import type { ControlStallProbeResult } from './control-stall-detector';

const block = (lines: string[] = [], args = '') => ({ args, isError: false, lines });

function createSink() {
  const events: Array<{ kind: ControlHealthKind } & ControlHealthInfo> = [];
  let state: ControlHealthKind | 'healthy' = 'healthy';
  const sink: ControlHealthSink = {
    get degraded() {
      return state !== 'healthy';
    },
    report(kind, info) {
      if (kind === 'recovered' ? state === 'healthy' : state === kind) return;
      state = kind === 'recovered' ? 'healthy' : kind;
      events.push({ kind, ...info });
    },
  };
  return { sink, events };
}

function createQueue(
  options: { stallMs?: number; probe?: () => ControlStallProbeResult; prepare?: () => void } = {}
) {
  const clock = createFakeClock();
  const { sink, events } = createSink();
  let poisoned = 0;
  const queue = new ControlModeCommandQueue(
    () => {
      poisoned += 1;
    },
    undefined,
    {
      clock,
      stallTimeoutMs: () => options.stallMs ?? 1_000,
      health: sink,
      stallProbe: options.probe ? { check: options.probe, prepare: options.prepare } : undefined,
    }
  );
  const settle = <T>(promise: Promise<T>) => {
    const state: { value?: T; error?: Error } = {};
    promise.then(
      (value) => {
        state.value = value;
      },
      (error: Error) => {
        state.error = error;
      }
    );
    return state;
  };
  return { clock, queue, events, poisoned: () => poisoned, settle };
}

const flush = () => Promise.resolve().then(() => undefined);

describe('control queue head-relative timeouts', () => {
  test('a command behind a slow head starts its clock when it reaches the head', async () => {
    const { clock, queue, settle } = createQueue();
    const a = settle(queue.execute(() => {}, 'a', { timeoutMs: 100, transform: () => 'a' }));
    const b = settle(queue.execute(() => {}, 'b', { timeoutMs: 100, transform: () => 'b' }));
    clock.advance(90);
    queue.handleBlock(block());
    clock.advance(60);
    await flush();
    expect(a.value).toBe('a');
    expect(b.error).toBeUndefined();
    clock.advance(40);
    await flush();
    expect(b.error?.message).toMatch(/timed out: b/);
    queue.dispose();
  });

  test('a command stuck behind a timed-out head hits the hard bound from enqueue', async () => {
    const { clock, queue, settle } = createQueue({ stallMs: 10_000 });
    const a = settle(queue.execute(() => {}, 'a', { timeoutMs: 100, transform: () => 'a' }));
    const b = settle(queue.execute(() => {}, 'b', { timeoutMs: 40, transform: () => 'b' }));
    clock.advance(100);
    await flush();
    expect(a.error?.message).toMatch(/timed out: a/);
    expect(b.error).toBeUndefined();
    clock.advance(60);
    await flush();
    expect(b.error?.message).toMatch(/timed out: b/);
    queue.dispose();
  });

  test('head timeout with later commands pending keeps late %end aligned', async () => {
    const { clock, queue, settle, poisoned } = createQueue();
    const a = settle(queue.execute(() => {}, 'a', { timeoutMs: 100, transform: () => 'a' }));
    const b = settle(
      queue.execute(() => {}, 'b', { timeoutMs: 500, transform: (blk) => blk.lines[0] })
    );
    clock.advance(100);
    await flush();
    expect(a.error).toBeDefined();
    expect(queue.handleBlock(block(['late-a']))).toBe(true);
    expect(queue.handleBlock(block(['b-out']))).toBe(true);
    await flush();
    expect(b.value).toBe('b-out');
    expect(poisoned()).toBe(0);
    queue.dispose();
  });

  test('non-head timeout stays queued so its late %end is swallowed, not stamped on the next', async () => {
    const { clock, queue, settle } = createQueue({ stallMs: 10_000 });
    const a = settle(
      queue.execute(() => {}, 'a', { timeoutMs: 1_000, transform: (blk) => blk.lines[0] })
    );
    const b = settle(queue.execute(() => {}, 'b', { timeoutMs: 10, transform: () => 'b' }));
    clock.advance(40);
    await flush();
    expect(b.error?.message).toMatch(/timed out: b/);
    queue.handleBlock(block(['a-out']));
    expect(queue.handleBlock(block(['late-b']))).toBe(true);
    const c = settle(queue.execute(() => {}, 'c', { transform: (blk) => blk.lines[0] }));
    queue.handleBlock(block(['c-out']));
    await flush();
    expect(a.value).toBe('a-out');
    expect(c.value).toBe('c-out');
    queue.dispose();
  });

  test('default timeout is read from the getter at enqueue time', async () => {
    const clock = createFakeClock();
    let timeoutMs = 50;
    const queue = new ControlModeCommandQueue(undefined, undefined, {
      clock,
      defaultTimeoutMs: () => timeoutMs,
    });
    const first = queue.execute(() => {}, 'a', { poisonOnTimeout: false, transform: () => 1 });
    first.catch(() => {});
    timeoutMs = 5_000;
    clock.advance(50);
    await expect(first).rejects.toThrow(/timed out/);
    queue.dispose();
  });
});

describe('control queue stall poisoning', () => {
  test('poisons only after a full stall window without any control activity', async () => {
    const { clock, queue, settle, poisoned, events } = createQueue();
    const a = settle(queue.execute(() => {}, 'a', { timeoutMs: 100, transform: () => 'a' }));
    clock.advance(100);
    await flush();
    expect(a.error).toBeDefined();
    expect(poisoned()).toBe(0);
    clock.advance(400);
    queue.noteActivity();
    clock.advance(900);
    expect(poisoned()).toBe(0);
    clock.advance(100);
    expect(poisoned()).toBe(1);
    expect(events.map((event) => event.kind)).toEqual(['slow', 'stalled']);
    await expect(queue.execute(() => {}, 'x', { transform: () => 0 })).rejects.toThrow(/closed/);
  });

  test('a slow channel that keeps producing output is never poisoned', () => {
    const { clock, queue, poisoned } = createQueue();
    void queue.execute(() => {}, 'a', { timeoutMs: 100, transform: () => 'a' }).catch(() => {});
    for (let i = 0; i < 40; i += 1) {
      clock.advance(500);
      queue.noteActivity();
    }
    expect(poisoned()).toBe(0);
    queue.dispose();
  });

  test('an expired orphan still counts as outstanding for stall detection', () => {
    const { clock, queue, poisoned } = createQueue();
    void queue.execute(() => {}, 'a', { timeoutMs: 100, transform: () => 'a' }).catch(() => {});
    clock.advance(300);
    expect(queue.busy).toBe(false);
    clock.advance(700);
    expect(poisoned()).toBe(1);
  });

  test('non-poisoning commands alone never poison the queue', () => {
    const { clock, queue, poisoned } = createQueue();
    void queue
      .execute(() => {}, 'probe', { timeoutMs: 100, poisonOnTimeout: false, transform: () => 0 })
      .catch(() => {});
    clock.advance(5_000);
    expect(poisoned()).toBe(0);
    expect(queue.assessStall(0)).toBe('stalled');
    queue.dispose();
  });

  test('an idle queue does not count old silence once a command arrives', () => {
    const { clock, queue, poisoned } = createQueue();
    clock.advance(10_000);
    void queue.execute(() => {}, 'a', { timeoutMs: 100, transform: () => 'a' }).catch(() => {});
    clock.advance(999);
    expect(poisoned()).toBe(0);
    clock.advance(1);
    expect(poisoned()).toBe(1);
  });

  test('alive tmux server extends the stall window at most three times', () => {
    let prepared = 0;
    const { clock, queue, poisoned, events } = createQueue({
      probe: () => 'alive',
      prepare: () => {
        prepared += 1;
      },
    });
    void queue.execute(() => {}, 'a', { timeoutMs: 100, transform: () => 'a' }).catch(() => {});
    void queue.execute(() => {}, 'b', { timeoutMs: 100, transform: () => 'b' }).catch(() => {});
    clock.advance(3_999);
    expect(poisoned()).toBe(0);
    clock.advance(1);
    expect(poisoned()).toBe(1);
    expect(prepared).toBe(1);
    expect(events.map((event) => event.kind)).toEqual(['slow', 'stalled']);
  });

  test('stopped or missing tmux server poisons at the first stall window', () => {
    const { clock, queue, poisoned } = createQueue({ probe: () => 'dead' });
    void queue.execute(() => {}, 'a', { timeoutMs: 100, transform: () => 'a' }).catch(() => {});
    clock.advance(1_000);
    expect(poisoned()).toBe(1);
  });
});

describe('control queue health transitions', () => {
  test('slow fires once per incident and recovered on the next normal completion', async () => {
    const { clock, queue, events } = createQueue({ stallMs: 60_000 });
    void queue.execute(() => {}, 'a', { timeoutMs: 100, transform: () => 'a' }).catch(() => {});
    void queue.execute(() => {}, 'b', { timeoutMs: 100, transform: () => 'b' }).catch(() => {});
    clock.advance(100);
    queue.handleBlock(block(['late-a']));
    clock.advance(100);
    expect(events.map((event) => event.kind)).toEqual(['slow']);
    expect(events[0]?.headAgeMs).toBe(100);
    queue.handleBlock(block(['late-b']));
    const c = queue.execute(() => {}, 'c', { transform: () => 'c' });
    queue.handleBlock(block());
    await expect(c).resolves.toBe('c');
    expect(events.map((event) => event.kind)).toEqual(['slow', 'recovered']);
    queue.dispose();
  });

  test('a late %end that empties the backlog reports recovery', () => {
    const { clock, queue, events } = createQueue({ stallMs: 60_000 });
    void queue.execute(() => {}, 'a', { timeoutMs: 100, transform: () => 'a' }).catch(() => {});
    clock.advance(100);
    queue.noteActivity();
    expect(events.map((event) => event.kind)).toEqual(['slow']);
    clock.advance(50);
    expect(queue.handleBlock(block(['late-a']))).toBe(true);
    expect(events.map((event) => event.kind)).toEqual(['slow', 'recovered']);
    queue.dispose();
  });
});

describe('unnumbered orphans keep FIFO alignment', () => {
  test('a literal head that timed out before its %begin still owns the next block', async () => {
    const { clock, queue, settle } = createQueue({ stallMs: 600_000 });
    const capture = settle(
      queue.execute(() => {}, 'capture-pane -p', {
        literal: true,
        timeoutMs: 100,
        transform: (blk) => blk.lines.join('\n'),
      })
    );
    const next = settle(
      queue.execute(() => {}, 'send-keys', { timeoutMs: 10_000, transform: (blk) => blk.lines[0] })
    );
    clock.advance(100);
    await flush();
    expect(capture.error).toBeDefined();
    clock.advance(5_000);
    expect(queue.nextBlockIsLiteral('1 5 0')).toBe(true);
    expect(queue.handleBlock(block(['%output %1 screen text'], '1 5 0'))).toBe(true);
    expect(queue.nextBlockIsLiteral('1 6 0')).toBe(false);
    expect(queue.handleBlock(block(['next-out'], '1 6 0'))).toBe(true);
    await flush();
    expect(next.value).toBe('next-out');
    queue.dispose();
  });

  test('two unnumbered orphans take late %begin blocks strictly in FIFO order', async () => {
    const { clock, queue, settle } = createQueue({ stallMs: 600_000 });
    void queue
      .execute(() => {}, 'a', { timeoutMs: 100, transform: () => 'a' })
      .catch(() => undefined);
    void queue
      .execute(() => {}, 'b', { literal: true, timeoutMs: 100, transform: () => 'b' })
      .catch(() => undefined);
    clock.advance(10_000);
    const user = settle(queue.execute(() => {}, 'c', { transform: (blk) => blk.lines[0] }));
    expect(queue.nextBlockIsLiteral('1 7 0')).toBe(false);
    expect(queue.handleBlock(block(['late-a'], '1 7 0'))).toBe(true);
    expect(queue.nextBlockIsLiteral('1 8 0')).toBe(true);
    expect(queue.handleBlock(block(['late-b'], '1 8 0'))).toBe(true);
    expect(queue.nextBlockIsLiteral('1 9 0')).toBe(false);
    expect(queue.handleBlock(block(['c-out'], '1 9 0'))).toBe(true);
    await flush();
    expect(user.value).toBe('c-out');
    queue.dispose();
  });

  test('a numbered orphan past its deadline is discarded by seq', async () => {
    const { clock, queue, settle } = createQueue({ stallMs: 600_000 });
    const a = settle(queue.execute(() => {}, 'a', { timeoutMs: 100, transform: () => 'a' }));
    expect(queue.nextBlockIsLiteral('1 3 0')).toBe(false);
    clock.advance(300);
    await flush();
    expect(a.error).toBeDefined();
    const user = settle(queue.execute(() => {}, 'u', { transform: (blk) => blk.lines[0] }));
    expect(queue.handleBlock(block(['late-a'], '1 3 0'))).toBe(true);
    expect(queue.nextBlockIsLiteral('1 4 0')).toBe(false);
    expect(queue.handleBlock(block(['u-out'], '1 4 0'))).toBe(true);
    await flush();
    expect(user.value).toBe('u-out');
    queue.dispose();
  });
});
