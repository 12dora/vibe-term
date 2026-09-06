import { describe, expect, test } from 'bun:test';
import type { MeshNotificationForwardRequest } from '@vibeterm/shared';
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

  test('投递卡住时按截止时间超时，队列继续排空', async () => {
    const logs: string[] = [];
    const clock = fakeClock();
    const signals: AbortSignal[] = [];
    let hang = true;
    const forwarder = new MeshNotificationForwarder({
      now: clock.now,
      delay: clock.delay,
      log: (line) => logs.push(line),
      deadlineMs: 15_000,
      deliver: (_sink, _body, signal) => {
        signals.push(signal);
        if (hang) return new Promise<Response>(() => {});
        return Promise.resolve(new Response('{}', { status: 202 }));
      },
    });
    forwarder.enqueue('sink-1', body());
    await clock.advance(0);
    expect(signals.length).toBe(1);
    expect(forwarder.pending).toBe(0); // 出队在途

    await clock.advance(15_000);
    await clock.advance(0);
    expect(signals[0]?.aborted).toBe(true);
    expect(logs.some((line) => line.includes('forward timeout sink=sink-1'))).toBe(true);
    expect(forwarder.pending).toBe(1);

    hang = false;
    await clock.advance(1_000);
    await clock.advance(0);
    expect(signals.length).toBe(2);
    expect(forwarder.pending).toBe(0);
  });

  test('投递成功后取消截止定时器，不留悬挂 timer', async () => {
    const clock = fakeClock();
    const forwarder = new MeshNotificationForwarder({
      now: clock.now,
      delay: clock.delay,
      deliver: async () => new Response('{}', { status: 202 }),
    });
    forwarder.enqueue('sink-1', body());
    await clock.advance(0);
    expect(clock.pending.length).toBe(0);
  });

  test('stop() 之后在途投递结束也不再回插、不再起定时器', async () => {
    const clock = fakeClock();
    let fail = (_err: Error): void => {};
    const forwarder = new MeshNotificationForwarder({
      now: clock.now,
      delay: clock.delay,
      deliver: () =>
        new Promise<Response>((_resolve, reject) => {
          fail = reject;
        }),
    });
    forwarder.enqueue('sink-1', body());
    await clock.advance(0);
    expect(clock.pending.length).toBe(1); // 只有截止定时器

    forwarder.stop();
    await clock.advance(0);
    expect(clock.pending.length).toBe(0);
    fail(new Error('aborted'));
    await clock.advance(0);
    await clock.advance(0);
    expect(clock.pending.length).toBe(0);
    expect(forwarder.pending).toBe(0);

    forwarder.enqueue('sink-1', body());
    await clock.advance(0);
    expect(clock.pending.length).toBe(0);
    expect(forwarder.pending).toBe(0);
  });

  test('forget 期间在途投递失败也不会给已丢弃的队列排定时器', async () => {
    const clock = fakeClock();
    let fail = (_err: Error): void => {};
    const forwarder = new MeshNotificationForwarder({
      now: clock.now,
      delay: clock.delay,
      deliver: () =>
        new Promise<Response>((_resolve, reject) => {
          fail = reject;
        }),
    });
    forwarder.enqueue('sink-1', body());
    await clock.advance(0);
    forwarder.forget('sink-1');
    fail(new Error('offline'));
    await clock.advance(0);
    await clock.advance(0);
    expect(clock.pending.length).toBe(0);
    expect(forwarder.pending).toBe(0);
  });
});

describe('汇聚声明被撤销', () => {
  test('重试前重新核对：撤销后不再投递，队列与丢弃计数一并收尾', async () => {
    const sent: string[] = [];
    const dropped: string[] = [];
    const clock = fakeClock();
    let authorized = true;
    const forwarder = new MeshNotificationForwarder({
      now: clock.now,
      delay: clock.delay,
      log: (line) => dropped.push(line),
      isSinkAuthorized: () => authorized,
      deliver: async (sink) => {
        sent.push(sink);
        return new Response('{}', { status: 502 });
      },
    });

    forwarder.enqueue('node-b', body());
    await clock.advance(0);
    expect(sent).toEqual(['node-b']);
    expect(forwarder.pending).toBe(1);

    // 首投失败、等重试期间用户撤销了这台汇聚机的签名声明。
    authorized = false;
    await clock.advance(1_000);
    expect(sent).toEqual(['node-b']);
    expect(forwarder.pending).toBe(0);
    expect(dropped.some((line) => line.includes('reason=unauthorized'))).toBe(true);
    expect(forwarder.dropped).toBe(1);

    // 后续事件也不再入队。
    forwarder.enqueue('node-b', body('%2'));
    await clock.advance(0);
    expect(forwarder.pending).toBe(0);
    expect(sent).toEqual(['node-b']);
  });

  test('pruneUnauthorized 立刻丢队列并 abort 在途投递', async () => {
    const clock = fakeClock();
    let authorized = true;
    const aborted: boolean[] = [];
    let release: (res: Response) => void = () => {};
    const forwarder = new MeshNotificationForwarder({
      now: clock.now,
      delay: clock.delay,
      isSinkAuthorized: () => authorized,
      deliver: (_sink, _payload, signal) =>
        new Promise<Response>((resolve) => {
          signal.addEventListener('abort', () => aborted.push(true), { once: true });
          release = resolve;
        }),
    });

    forwarder.enqueue('node-b', body());
    await clock.advance(0);
    expect(forwarder.pending).toBe(0); // 这一条已经出队，正在途中

    authorized = false;
    forwarder.pruneUnauthorized();
    expect(aborted).toEqual([true]);

    // 在途投递即使随后返回 200，也不会再有队列复活。
    release(new Response('{}', { status: 200 }));
    await clock.advance(0);
    expect(forwarder.pending).toBe(0);
  });
});
