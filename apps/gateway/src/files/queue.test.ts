import { describe, expect, test } from 'bun:test';
import {
  DEVICE_READ_CONCURRENCY,
  DEVICE_TRANSFER_CONCURRENCY,
  type DeviceJobKind,
  GLOBAL_MAX_CONCURRENT,
  enqueueDeviceJob,
} from './queue';

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function hold(
  deviceId: string,
  kind: DeviceJobKind,
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

  test('a failing read does not block the next job on the same device', async () => {
    const p1 = enqueueDeviceJob('fail-r', 'read', () => Promise.reject(new Error('boom')));
    const p2 = enqueueDeviceJob('fail-r', 'transfer', () => Promise.resolve('ok'));
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('ok');
  });

  test('reads proceed while 3 transfers run and do not take a transfer slot', async () => {
    const events: string[] = [];
    const gates = Array.from({ length: 5 }, () => deferred());
    const jobs = [
      hold('read-lane', 'transfer', events, 't0', gates[0].promise),
      hold('read-lane', 'transfer', events, 't1', gates[1].promise),
      hold('read-lane', 'transfer', events, 't2', gates[2].promise),
      hold('read-lane', 'read', events, 'r0', gates[3].promise),
      hold('read-lane', 'read', events, 'r1', gates[4].promise),
    ];

    expect(events).toEqual(['start:t0', 'start:t1', 'start:t2', 'start:r0', 'start:r1']);

    const t3 = deferred();
    const p3 = hold('read-lane', 'transfer', events, 't3', t3.promise);
    expect(events).not.toContain('start:t3');

    gates[0].resolve();
    await jobs[0];
    expect(events).toContain('start:t3');

    for (const g of gates.slice(1)) g.resolve();
    t3.resolve();
    await Promise.all([...jobs, p3]);
  });

  test('reads still wait for a queued mutation', async () => {
    const events: string[] = [];
    const t1 = deferred();
    const m = deferred();
    const r = deferred();
    const p1 = hold('read-after-m', 'transfer', events, 't1', t1.promise);
    const pm = hold('read-after-m', 'mutation', events, 'm', m.promise);
    const pr = hold('read-after-m', 'read', events, 'r', r.promise);

    expect(events).toEqual(['start:t1']);
    t1.resolve();
    await p1;
    expect(events).toEqual(['start:t1', 'end:t1', 'start:m']);

    m.resolve();
    await pm;
    expect(events).toEqual(['start:t1', 'end:t1', 'start:m', 'end:m', 'start:r']);

    r.resolve();
    await pr;
  });

  test('a mutation waits for running reads', async () => {
    const events: string[] = [];
    const r1 = deferred();
    const r2 = deferred();
    const m = deferred();
    const p1 = hold('mut-after-read', 'read', events, 'r1', r1.promise);
    const p2 = hold('mut-after-read', 'read', events, 'r2', r2.promise);
    const pm = hold('mut-after-read', 'mutation', events, 'm', m.promise);

    expect(events).toEqual(['start:r1', 'start:r2']);
    r1.resolve();
    await p1;
    expect(events).toEqual(['start:r1', 'start:r2', 'end:r1']);

    r2.resolve();
    await p2;
    expect(events).toEqual(['start:r1', 'start:r2', 'end:r1', 'end:r2', 'start:m']);

    m.resolve();
    await pm;
    expect(events.at(-1)).toBe('end:m');
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

  test('queued reads start while a 4th transfer waits for a slot', async () => {
    const events: string[] = [];
    const gates = Array.from({ length: 6 }, () => deferred());
    const jobs = [
      hold('hol-read', 'transfer', events, 't0', gates[0].promise),
      hold('hol-read', 'transfer', events, 't1', gates[1].promise),
      hold('hol-read', 'transfer', events, 't2', gates[2].promise),
      hold('hol-read', 'transfer', events, 't3', gates[3].promise),
      hold('hol-read', 'read', events, 'r0', gates[4].promise),
      hold('hol-read', 'read', events, 'r1', gates[5].promise),
    ];

    expect(events).toEqual(['start:t0', 'start:t1', 'start:t2', 'start:r0', 'start:r1']);
    expect(events).not.toContain('start:t3');

    gates[0].resolve();
    await jobs[0];
    expect(events).toContain('start:t3');

    for (const g of gates.slice(1)) g.resolve();
    await Promise.all(jobs);
  });

  test('reads behind a queued mutation still wait for it', async () => {
    const events: string[] = [];
    const t1 = deferred();
    const t2 = deferred();
    const t3 = deferred();
    const t4 = deferred();
    const m = deferred();
    const r = deferred();
    const p1 = hold('hol-mut', 'transfer', events, 't1', t1.promise);
    const p2 = hold('hol-mut', 'transfer', events, 't2', t2.promise);
    const p3 = hold('hol-mut', 'transfer', events, 't3', t3.promise);
    const p4 = hold('hol-mut', 'transfer', events, 't4', t4.promise);
    const pm = hold('hol-mut', 'mutation', events, 'm', m.promise);
    const pr = hold('hol-mut', 'read', events, 'r', r.promise);

    expect(events).toEqual(['start:t1', 'start:t2', 'start:t3']);
    expect(events).not.toContain('start:t4');
    expect(events).not.toContain('start:r');
    t1.resolve();
    await p1;
    expect(events).toContain('start:t4');
    expect(events).not.toContain('start:m');
    expect(events).not.toContain('start:r');

    t2.resolve();
    t3.resolve();
    t4.resolve();
    await Promise.all([p2, p3, p4]);
    expect(events).toContain('start:m');
    expect(events).not.toContain('start:r');

    m.resolve();
    await pm;
    expect(events).toContain('start:r');
    r.resolve();
    await pr;
  });

  test('caps reads per device so one device cannot fill the global slots', async () => {
    const events: string[] = [];
    const gates = Array.from({ length: DEVICE_READ_CONCURRENCY + 2 }, () => deferred());
    const jobs = gates.map((g, i) => hold('read-cap', 'read', events, `r${i}`, g.promise));

    expect(events).toEqual(
      Array.from({ length: DEVICE_READ_CONCURRENCY }, (_, i) => `start:r${i}`)
    );
    expect(events).not.toContain(`start:r${DEVICE_READ_CONCURRENCY}`);

    const t = deferred();
    const pt = hold('read-cap', 'transfer', events, 't0', t.promise);
    expect(events).toContain('start:t0');

    for (const g of gates) g.resolve();
    t.resolve();
    await Promise.all([...jobs, pt]);
    expect(events.filter((e) => e.startsWith('start:r'))).toHaveLength(
      DEVICE_READ_CONCURRENCY + 2
    );
  });
});
