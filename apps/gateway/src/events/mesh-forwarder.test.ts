import { describe, expect, test } from 'bun:test';
import type { MeshNotificationForwardRequest } from '@tmex/shared';
import { MeshNotificationForwarder } from './mesh-forwarder';

function body(paneId = '%1'): MeshNotificationForwardRequest {
  return {
    eventType: 'terminal_bell',
    event: {
      site: { name: 'site', url: 'https://a.example' },
      device: { id: 'dev-1', name: 'dev', type: 'local' },
      tmux: { paneId },
    },
    origin: { nodeId: 'node-a', nodeName: 'A' },
  };
}

type Clock = {
  now: () => number;
  delay: (ms: number, fn: () => void) => () => void;
  advance: (ms: number) => Promise<void>;
  pending: Array<{ at: number; fn: () => void }>;
};

function fakeClock(): Clock {
  let current = 0;
  const pending: Array<{ at: number; fn: () => void }> = [];
  return {
    pending,
    now: () => current,
    delay(ms, fn) {
      const item = { at: current + ms, fn };
      pending.push(item);
      return () => {
        const index = pending.indexOf(item);
        if (index >= 0) pending.splice(index, 1);
      };
    },
    async advance(ms) {
      current += ms;
      for (const item of [...pending]) {
        if (item.at > current) continue;
        pending.splice(pending.indexOf(item), 1);
        item.fn();
      }
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('MeshNotificationForwarder', () => {
  test('在线时立即投递', async () => {
    const sent: string[] = [];
    const clock = fakeClock();
    const forwarder = new MeshNotificationForwarder({
      now: clock.now,
      delay: clock.delay,
      deliver: async (sink) => {
        sent.push(sink);
        return new Response('{}', { status: 200 });
      },
    });
    forwarder.enqueue('sink-1', body());
    await clock.advance(0);
    expect(sent).toEqual(['sink-1']);
    expect(forwarder.pending).toBe(0);
  });

  test('失败后按 1/2/4 秒退避重试，成功即清空', async () => {
    const attempts: number[] = [];
    const clock = fakeClock();
    let ok = false;
    const forwarder = new MeshNotificationForwarder({
      now: clock.now,
      delay: clock.delay,
      deliver: async () => {
        attempts.push(clock.now());
        if (!ok) throw new Error('offline');
        return new Response('{}', { status: 200 });
      },
    });
    forwarder.enqueue('sink-1', body());
    await clock.advance(0);
    expect(attempts).toEqual([0]);
    expect(forwarder.pending).toBe(1);
    await clock.advance(1_000);
    await clock.advance(2_000);
    ok = true;
    await clock.advance(4_000);
    expect(attempts).toEqual([0, 1_000, 3_000, 7_000]);
    expect(forwarder.pending).toBe(0);
  });

  test('退避期间入队的事件合并，不额外拉起投递', async () => {
    const attempts: string[] = [];
    const clock = fakeClock();
    const forwarder = new MeshNotificationForwarder({
      now: clock.now,
      delay: clock.delay,
      deliver: async () => {
        attempts.push('try');
        return new Response('{}', { status: 502 });
      },
    });
    forwarder.enqueue('sink-1', body());
    await clock.advance(0);
    forwarder.enqueue('sink-1', body());
    forwarder.enqueue('sink-1', body());
    await Promise.resolve();
    expect(attempts.length).toBe(1);
    expect(forwarder.pending).toBe(1);
  });

  test('汇聚机 404（开关已关）不再重试，直接丢弃', async () => {
    const logs: string[] = [];
    const clock = fakeClock();
    const forwarder = new MeshNotificationForwarder({
      now: clock.now,
      delay: clock.delay,
      log: (line) => logs.push(line),
      deliver: async () => new Response('{}', { status: 404 }),
    });
    forwarder.enqueue('sink-1', body());
    await clock.advance(0);
    expect(forwarder.pending).toBe(0);
    expect(clock.pending.length).toBe(0);
    expect(logs[0]).toContain('[notify] forward dropped sink=sink-1 reason=rejected status=404');
  });

  test('429 视作可重试', async () => {
    const clock = fakeClock();
    let calls = 0;
    const forwarder = new MeshNotificationForwarder({
      now: clock.now,
      delay: clock.delay,
      deliver: async () => {
        calls += 1;
        return new Response('{}', { status: 429 });
      },
    });
    forwarder.enqueue('sink-1', body());
    await clock.advance(0);
    await clock.advance(1_000);
    expect(calls).toBe(2);
    expect(forwarder.pending).toBe(1);
  });

  test('超限丢弃打日志并计数', async () => {
    const logs: string[] = [];
    const clock = fakeClock();
    const forwarder = new MeshNotificationForwarder({
      now: clock.now,
      delay: clock.delay,
      log: (line) => logs.push(line),
      deliver: async () => {
        throw new Error('offline');
      },
    });
    for (let i = 0; i < 22; i++) forwarder.enqueue('sink-1', body(`%${i}`));
    await clock.advance(0);
    expect(forwarder.dropped).toBeGreaterThan(0);
    expect(logs.some((line) => line.includes('reason=overflow'))).toBe(true);
  });

  test('forget 丢掉队列并取消退避', async () => {
    const clock = fakeClock();
    const forwarder = new MeshNotificationForwarder({
      now: clock.now,
      delay: clock.delay,
      deliver: async () => {
        throw new Error('offline');
      },
    });
    forwarder.enqueue('sink-1', body());
    await clock.advance(0);
    expect(clock.pending.length).toBe(1);
    forwarder.forget('sink-1');
    expect(clock.pending.length).toBe(0);
    expect(forwarder.pending).toBe(0);
  });

  test('多个汇聚机各自独立成队', async () => {
    const sent: string[] = [];
    const clock = fakeClock();
    const forwarder = new MeshNotificationForwarder({
      now: clock.now,
      delay: clock.delay,
      deliver: async (sink) => {
        sent.push(sink);
        if (sink === 'sink-2') throw new Error('offline');
        return new Response('{}', { status: 200 });
      },
    });
    forwarder.enqueue('sink-1', body());
    forwarder.enqueue('sink-2', body());
    await clock.advance(0);
    expect(sent.sort()).toEqual(['sink-1', 'sink-2']);
    expect(forwarder.pending).toBe(1);
  });
});
