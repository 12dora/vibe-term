import { describe, expect, test } from 'bun:test';
import { DEVICE_TRANSFER_CONCURRENCY, GLOBAL_MAX_CONCURRENT, enqueueDeviceJob } from './queue';

function deferred(): PromiseWithResolvers<void> {
  return Promise.withResolvers<void>();
}

function hold(
  deviceId: string,
  kind: 'transfer' | 'mutation',
  events: string[],
  id: string,
  gate: Promise<void>
): Promise<void> {
  return enqueueDeviceJob(deviceId, kind, async () => {
    events.push(`start:${id}`);
    await gate;
    events.push(`end:${id}`);
  });
}

describe('enqueueDeviceJob', () => {
  test('transfers on one device overlap up to 3; the 4th waits', async () => {
    const events: string[] = [];
    const gates = Array.from({ length: 4 }, () => deferred());
    const jobs = gates.map((g, i) => hold('ov', 'transfer', events, String(i), g.promise));

    expect(events).toEqual(['start:0', 'start:1', 'start:2']);
    expect(events).toHaveLength(DEVICE_TRANSFER_CONCURRENCY);

    gates[0].resolve();
    await jobs[0];
    expect(events).toEqual(['start:0', 'start:1', 'start:2', 'end:0', 'start:3']);

    for (const g of gates.slice(1)) g.resolve();
    await Promise.all(jobs);
    expect(events.filter((e) => e.startsWith('start:'))).toEqual([
      'start:0',
      'start:1',
      'start:2',
      'start:3',
    ]);
  });

  test('a mutation waits for running transfers on the same device', async () => {
    const events: string[] = [];
    const t1 = deferred();
    const t2 = deferred();
    const m = deferred();
    const p1 = hold('mw', 'transfer', events, 't1', t1.promise);
    const p2 = hold('mw', 'transfer', events, 't2', t2.promise);
    const pm = hold('mw', 'mutation', events, 'm', m.promise);

    expect(events).toEqual(['start:t1', 'start:t2']);
    t1.resolve();
    await p1;
    expect(events).toEqual(['start:t1', 'start:t2', 'end:t1']);

    t2.resolve();
    await p2;
    expect(events).toEqual(['start:t1', 'start:t2', 'end:t1', 'end:t2', 'start:m']);

    m.resolve();
    await pm;
    expect(events.at(-1)).toBe('end:m');
  });

  test('transfers queued after a mutation wait for it', async () => {
    const events: string[] = [];
    const t1 = deferred();
    const m = deferred();
    const t2 = deferred();
    const p1 = hold('after-m', 'transfer', events, 't1', t1.promise);
    const pm = hold('after-m', 'mutation', events, 'm', m.promise);
    const p2 = hold('after-m', 'transfer', events, 't2', t2.promise);

    expect(events).toEqual(['start:t1']);
    t1.resolve();
    await p1;
    expect(events).toEqual(['start:t1', 'end:t1', 'start:m']);

    m.resolve();
    await pm;
    expect(events).toEqual(['start:t1', 'end:t1', 'start:m', 'end:m', 'start:t2']);

    t2.resolve();
    await p2;
  });

  test('transfers enqueued before a mutation still take free slots', async () => {
    const events: string[] = [];
    const t1 = deferred();
    const t2 = deferred();
    const m = deferred();
    const p1 = hold('pre-m', 'transfer', events, 't1', t1.promise);
    const p2 = hold('pre-m', 'transfer', events, 't2', t2.promise);
    const pm = hold('pre-m', 'mutation', events, 'm', m.promise);

    expect(events).toEqual(['start:t1', 'start:t2']);
    t1.resolve();
    await p1;
    expect(events).toEqual(['start:t1', 'start:t2', 'end:t1']);

    t2.resolve();
    await p2;
    expect(events).toEqual(['start:t1', 'start:t2', 'end:t1', 'end:t2', 'start:m']);
    m.resolve();
    await pm;
  });

  test('jobs on different devices are independent', async () => {
    const events: string[] = [];
    const a = deferred();
    const b = deferred();
    const pa = hold('ind-a', 'mutation', events, 'a', a.promise);
    const pb = hold('ind-b', 'transfer', events, 'b', b.promise);
    const pc = hold('ind-c', 'mutation', events, 'c', b.promise);

    expect(events).toEqual(['start:a', 'start:b', 'start:c']);
    a.resolve();
    b.resolve();
    await Promise.all([pa, pb, pc]);
  });

  test('caps global concurrency across devices at 8', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const gates = Array.from({ length: 10 }, () => deferred());
    const jobs = gates.map((g, i) =>
      enqueueDeviceJob(`gcap-${i}`, 'transfer', async () => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await g.promise;
        inflight -= 1;
      })
    );

    expect(inflight).toBe(GLOBAL_MAX_CONCURRENT);
    expect(maxInflight).toBe(GLOBAL_MAX_CONCURRENT);

    gates[0].resolve();
    await jobs[0];
    expect(inflight).toBe(GLOBAL_MAX_CONCURRENT);

    for (const g of gates.slice(1)) g.resolve();
    await Promise.all(jobs);
    expect(maxInflight).toBe(GLOBAL_MAX_CONCURRENT);
    expect(inflight).toBe(0);
  });

  test('a failing transfer does not block later jobs on the same device', async () => {
    const p1 = enqueueDeviceJob('fail-t', 'transfer', () => Promise.reject(new Error('boom')));
    const p2 = enqueueDeviceJob('fail-t', 'transfer', () => Promise.resolve('ok'));
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('ok');
  });

  test('a failing mutation does not block the next job on the same device', async () => {
    const p1 = enqueueDeviceJob('fail-m', 'mutation', () => Promise.reject(new Error('boom')));
    const p2 = enqueueDeviceJob('fail-m', 'mutation', () => Promise.resolve('ok'));
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('ok');
  });

  test('mutations on one device run exclusively in FIFO order', async () => {
    const events: string[] = [];
    const g1 = deferred();
    const p1 = hold('mut-fifo', 'mutation', events, '1', g1.promise);
    const p2 = hold('mut-fifo', 'mutation', events, '2', Promise.resolve());
    const p3 = hold('mut-fifo', 'mutation', events, '3', Promise.resolve());

    expect(events).toEqual(['start:1']);
    g1.resolve();
    await Promise.all([p1, p2, p3]);
    expect(events).toEqual(['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3']);
  });
});
